/**
 * Pre Event Status Service
 * Handles monotonic status promotion for pre-events based on eligible provider events
 * 
 * Rules:
 * - Eligible providers: identity_matched_provider_ids (preferred) or linked_provider_ids (fallback)
 * - Canonical status = MAX(provider.event_status_id) across eligible providers
 * - Never regress (monotonic)
 * - When promoting to OFF_TIME, finalize event_actual_start_time in same transaction
 * - When promoting to FINISHED, finalize both actual_start_time and end_time
 */

import { DatabaseService } from '../utils/database.js';
import { Knex } from 'knex';
import { logger } from '../utils/logger.js';
import { PreEventRepository } from '../repositories/preEventRepository.js';
import { EventRepository } from '../repositories/eventRepository.js';
import { EVENT_STATUS_IDS } from '../config/index.js';

export class PreEventStatusService {
    private static db = DatabaseService.getInstance();

    /**
     * Promote pre-event status if needed based on eligible provider events
     * Called when a provider event's status changes
     * 
     * @param preEventId - The pre-event ID
     * @param triggerProviderId - The provider that triggered this check (for source tracking)
     * @param trx - Transaction (required for atomicity)
     * @returns true if status was promoted, false otherwise
     */
    static async promoteStatusIfNeeded(
        preEventId: number,
        triggerProviderId: number,
        trx: Knex.Transaction
    ): Promise<boolean> {
        try {
            // Load current pre-event state
            const preEvent = await PreEventRepository.getPreEvent(preEventId, trx);
            if (!preEvent) {
                logger.warn('Pre-event not found for status promotion', { preEventId });
                return false;
            }

            // Get eligible provider events
            const eligibleProviderEvents = await this.getEligibleProviderEvents(preEventId, trx);
            
            if (eligibleProviderEvents.length === 0) {
                logger.debug('No eligible provider events for status promotion', { preEventId });
                return false;
            }

            // Compute MAX(event_status_id) across eligible providers
            const candidateStatus = Math.max(
                ...eligibleProviderEvents.map(e => e.event_status_id || EVENT_STATUS_IDS.PRE_RACE)
            );

            const currentStatus = preEvent.event_status_id || EVENT_STATUS_IDS.PRE_RACE;

            // Monotonic check: only promote if candidate > current
            if (candidateStatus <= currentStatus) {
                logger.debug('Status promotion not needed (monotonic check)', {
                    preEventId,
                    currentStatus,
                    candidateStatus
                });
                return false;
            }

            logger.info('Promoting pre-event status', {
                preEventId,
                currentStatus,
                candidateStatus,
                triggerProviderId,
                eligibleProviderCount: eligibleProviderEvents.length
            });

            // Determine which provider caused the max (for source tracking)
            const maxStatusProvider = eligibleProviderEvents.find(
                e => e.event_status_id === candidateStatus
            );
            const sourceProviderId = maxStatusProvider?.provider_id || triggerProviderId;

            // Prepare updates
            const updates: any = {
                event_status_id: candidateStatus,
                event_status_source_provider_id: sourceProviderId,
                updated_at: new Date()
            };

            // Finalize timestamps based on new status
            if (candidateStatus === EVENT_STATUS_IDS.OFF_TIME) {
                await this.finalizeActualStartTime(preEventId, eligibleProviderEvents, sourceProviderId, trx, updates);
            } else if (candidateStatus === EVENT_STATUS_IDS.FINISHED) {
                // FINISHED: finalize both actual_start_time and end_time
                await this.finalizeActualStartTime(preEventId, eligibleProviderEvents, sourceProviderId, trx, updates);
                await this.finalizeEndTime(preEventId, eligibleProviderEvents, sourceProviderId, trx, updates);
                
                // Also finalize dividend_info if available
                await this.finalizeDividendInfo(preEventId, eligibleProviderEvents, sourceProviderId, trx, updates);
            }

            // Update pre-event atomically
            await PreEventRepository.updatePreEventStatus(preEventId, updates, trx);

            // Insert history record
            await PreEventRepository.insertPreEventHistory(
                preEventId,
                candidateStatus,
                trx
            );

            logger.info('Pre-event status promoted successfully', {
                preEventId,
                oldStatus: currentStatus,
                newStatus: candidateStatus,
                sourceProviderId
            });

            return true;

        } catch (error) {
            logger.error('Error promoting pre-event status', error as Error, {
                preEventId,
                triggerProviderId
            });
            throw error;
        }
    }

    /**
     * Get eligible provider events for status computation
     * Uses identity_matched_provider_ids if available, else linked_provider_ids
     */
    private static async getEligibleProviderEvents(
        preEventId: number,
        trx: Knex.Transaction
    ): Promise<any[]> {
        // Load pre-event to get coverage arrays
        const preEvent = await PreEventRepository.getPreEvent(preEventId, trx);
        if (!preEvent) {
            return [];
        }

        // Determine eligible provider IDs
        let eligibleProviderIds: number[] = [];

        // Prefer identity_matched_provider_ids
        if (preEvent.identity_matched_provider_ids && 
            Array.isArray(preEvent.identity_matched_provider_ids) && 
            preEvent.identity_matched_provider_ids.length > 0) {
            eligibleProviderIds = preEvent.identity_matched_provider_ids;
        } 
        // Fallback to linked_provider_ids
        else if (preEvent.linked_provider_ids && 
                 Array.isArray(preEvent.linked_provider_ids) && 
                 preEvent.linked_provider_ids.length > 0) {
            eligibleProviderIds = preEvent.linked_provider_ids;
        }

        if (eligibleProviderIds.length === 0) {
            return [];
        }

        // Load provider events for eligible providers
        return await EventRepository.getEligibleProviderEventsByPreEventId(
            preEventId,
            eligibleProviderIds,
            trx
        );
    }

    /**
     * Finalize event_actual_start_time when promoting to OFF_TIME
     * Sets actual_start_time to MIN(provider.actual_start_time) or NOW() if none available
     */
    private static async finalizeActualStartTime(
        preEventId: number,
        providerEvents: any[],
        sourceProviderId: number,
        trx: Knex.Transaction,
        updates: any
    ): Promise<void> {
        // Check if already finalized
        const preEvent = await PreEventRepository.getPreEvent(preEventId, trx);
        if (preEvent?.event_actual_start_time_final) {
            logger.debug('Actual start time already finalized', { preEventId });
            return;
        }

        // Find MIN(non-null provider.event_actual_start_time)
        const actualStartTimes = providerEvents
            .map(e => e.event_actual_start_time)
            .filter((t): t is Date => t != null)
            .map(t => new Date(t));

        let actualStartTime: Date;
        let actualStartSourceProviderId: number;

        if (actualStartTimes.length > 0) {
            // Use MIN of provider actual start times
            actualStartTime = new Date(Math.min(...actualStartTimes.map(t => t.getTime())));
            
            // Find provider that supplied the MIN
            const minProviderEvent = providerEvents.find(
                e => e.event_actual_start_time && 
                new Date(e.event_actual_start_time).getTime() === actualStartTime.getTime()
            );
            actualStartSourceProviderId = minProviderEvent?.provider_id || sourceProviderId;
        } else {
            // No provider supplies it - use current timestamp (derived actual start)
            actualStartTime = new Date();
            actualStartSourceProviderId = sourceProviderId;
            
            logger.debug('No provider supplied actual_start_time, using current timestamp', {
                preEventId,
                derivedTime: actualStartTime
            });
        }

        updates.event_actual_start_time = actualStartTime;
        updates.event_actual_start_time_source_provider_id = actualStartSourceProviderId;
        updates.event_actual_start_time_final = true;

        logger.debug('Finalized actual start time', {
            preEventId,
            actualStartTime,
            sourceProviderId: actualStartSourceProviderId
        });
    }

    /**
     * Finalize event_end_time when promoting to FINISHED
     * Sets end_time to MAX(provider.end_time) or NOW() if none available
     */
    private static async finalizeEndTime(
        preEventId: number,
        providerEvents: any[],
        sourceProviderId: number,
        trx: Knex.Transaction,
        updates: any
    ): Promise<void> {
        // Check if already finalized
        const preEvent = await PreEventRepository.getPreEvent(preEventId, trx);
        if (preEvent?.event_end_time_final) {
            logger.debug('End time already finalized', { preEventId });
            return;
        }

        // Find MAX(non-null provider.event_end_time)
        const endTimes = providerEvents
            .map(e => e.event_end_time)
            .filter((t): t is Date => t != null)
            .map(t => new Date(t));

        let endTime: Date;
        let endTimeSourceProviderId: number;

        if (endTimes.length > 0) {
            // Use MAX of provider end times
            endTime = new Date(Math.max(...endTimes.map(t => t.getTime())));
            
            // Find provider that supplied the MAX
            const maxProviderEvent = providerEvents.find(
                e => e.event_end_time && 
                new Date(e.event_end_time).getTime() === endTime.getTime()
            );
            endTimeSourceProviderId = maxProviderEvent?.provider_id || sourceProviderId;
        } else {
            // No provider supplies it - use current timestamp
            endTime = new Date();
            endTimeSourceProviderId = sourceProviderId;
            
            logger.debug('No provider supplied end_time, using current timestamp', {
                preEventId,
                derivedTime: endTime
            });
        }

        updates.event_end_time = endTime;
        updates.event_end_time_source_provider_id = endTimeSourceProviderId;
        updates.event_end_time_final = true;

        logger.debug('Finalized end time', {
            preEventId,
            endTime,
            sourceProviderId: endTimeSourceProviderId
        });
    }

    /**
     * Finalize dividend_info when promoting to FINISHED
     * Uses dividend_info from the provider that triggered the status change
     */
    private static async finalizeDividendInfo(
        preEventId: number,
        providerEvents: any[],
        sourceProviderId: number,
        trx: Knex.Transaction,
        updates: any
    ): Promise<void> {
        // Find provider event that matches source provider
        const sourceProviderEvent = providerEvents.find(
            e => e.provider_id === sourceProviderId
        );

        if (sourceProviderEvent?.dividend_info) {
            // Use dividend_info from source provider
            updates.dividend_info = sourceProviderEvent.dividend_info;
            updates.dividend_info_source_provider_id = sourceProviderId;
            
            logger.debug('Finalized dividend info', {
                preEventId,
                sourceProviderId,
                dividendInfo: sourceProviderEvent.dividend_info
            });
        } else {
            // Try to find any provider with dividend_info
            const providerWithDividend = providerEvents.find(
                e => e.dividend_info != null
            );

            if (providerWithDividend) {
                updates.dividend_info = providerWithDividend.dividend_info;
                updates.dividend_info_source_provider_id = providerWithDividend.provider_id;
                
                logger.debug('Finalized dividend info from alternative provider', {
                    preEventId,
                    sourceProviderId: providerWithDividend.provider_id
                });
            }
        }
    }
}

