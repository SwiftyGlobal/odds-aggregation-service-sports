/**
 * Pre Event Status Service
 * Handles monotonic status promotion for pre-events based on eligible provider events
 *
 * Rules:
 * - Eligible providers: identity_matched_provider_ids (preferred) or linked_provider_ids (fallback)
 * - Canonical status = MAX(provider.event_status_id) across eligible providers
 * - Never regress (monotonic)
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

            const updates: any = {
                event_status_id: candidateStatus,
                updated_at: new Date()
            };

            if (candidateStatus === EVENT_STATUS_IDS.FINISHED) {
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

