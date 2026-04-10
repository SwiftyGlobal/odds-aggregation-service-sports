/**
 * Pre Event Projection Service
 * Handles projection from provider tables to pre tables:
 * - dividend_info (provider events -> pre events map + display_dividend_info)
 * - positions (provider participants -> pre participants with source tracking)
 * - monitoring_started_at / monitoring_ended_at (lifecycle timestamps)
 * 
 * All projectors use transactions with row-level locking to prevent concurrent races.
 */

import { Knex } from 'knex';
import { logger } from '../utils/logger.js';
import { PreEventRepository } from '../repositories/preEventRepository.js';
import { PreEventParticipantRepository } from '../repositories/preEventParticipantRepository.js';
import { EventParticipantRepository } from '../repositories/eventParticipantRepository.js';
import { EventRepository } from '../repositories/eventRepository.js';
import { TABLES } from '../constants/tables.js';
import { getSportAdapter } from '../adapters/index.js';

// Track which pre_event_ids are currently being projected (simple deduplication)
// Use string keys to handle both string and number inputs consistently
const positionProjectionInProgress = new Set<string>();
const monitoringEndedCheckInProgress = new Set<string>();

export class PreEventProjectionService {
    /**
     * Project dividend_info from provider events to pre-event
     * Builds a map of { [providerId]: dividendInfo } and selects display_dividend_info
     * 
     * @param preEventId - The pre-event ID
     * @param triggerProviderId - The provider that triggered this projection (preferred for display)
     * @param trx - Transaction (required)
     */
    static async projectDividendInfo(
        preEventId: number,
        triggerProviderId: number,
        trx: Knex.Transaction
    ): Promise<void> {
        // Schema v2 stores optional dividend data in metadata and does not require projection for core flow.
        void preEventId;
        void triggerProviderId;
        void trx;
        return;
        try {
            // Lock pre-event row to prevent concurrent projector races
            const preEvent = await PreEventRepository.lockForProjection(preEventId, trx);
            if (!preEvent) {
                logger.warn('Pre-event not found for dividend projection', { preEventId });
                return;
            }

            // Get eligible provider IDs
            const eligibleProviderIds = PreEventRepository.getEligibleProviderIds(preEvent);
            if (eligibleProviderIds.length === 0) {
                logger.debug('No eligible providers for dividend projection', { preEventId });
                return;
            }

            // Load all provider events for this pre-event from eligible providers
            const providerEvents = await EventRepository.getEligibleProviderEventsByPreEventId(
                preEventId,
                eligibleProviderIds,
                trx
            );

            if (providerEvents.length === 0) {
                logger.debug('No provider events found for dividend projection', { preEventId });
                return;
            }

            // Build dividend_info map: { [providerId]: provider.dividend_info }
            const dividendInfoMap: Record<string, any> = {};
            let displayDividendInfo: any = null;
            let displaySourceProviderId: number | null = null;

            for (const providerEvent of providerEvents) {
                if (providerEvent.dividend_info) {
                    const providerId = providerEvent.provider_id.toString();
                    dividendInfoMap[providerId] = providerEvent.dividend_info;

                    // Prefer trigger provider for display_dividend_info
                    if (providerEvent.provider_id === triggerProviderId && !displayDividendInfo) {
                        displayDividendInfo = providerEvent.dividend_info;
                        displaySourceProviderId = triggerProviderId;
                    }
                }
            }

            // If trigger provider didn't have dividend_info, use first available
            if (!displayDividendInfo) {
                for (const providerEvent of providerEvents) {
                    if (providerEvent.dividend_info) {
                        displayDividendInfo = providerEvent.dividend_info;
                        displaySourceProviderId = providerEvent.provider_id;
                        break;
                    }
                }
            }

            // Update dividend_info map
            if (Object.keys(dividendInfoMap).length > 0) {
                await PreEventRepository.updateDividendInfoMap(preEventId, dividendInfoMap, trx);

                logger.debug('Dividend info map updated', {
                    preEventId,
                    providerCount: Object.keys(dividendInfoMap).length
                });
            }

            // Update display_dividend_info if available
            if (displayDividendInfo && displaySourceProviderId != null) {
                await PreEventRepository.updateDisplayDividendInfo(
                    preEventId,
                    displayDividendInfo,
                    displaySourceProviderId as number,
                    trx
                );

                logger.debug('Display dividend info updated', {
                    preEventId,
                    sourceProviderId: displaySourceProviderId
                });
            }

        } catch (error) {
            logger.error('Error projecting dividend info', error as Error, { preEventId, triggerProviderId });
            throw error;
        }
    }

    /**
     * Project positions from provider participants to pre participants
     * Selects best provider based on completeness and updates pre positions with source tracking
     * 
     * @param preEventId - The pre-event ID
     * @param trx - Transaction (required)
     */
    static async projectPositions(
        preEventId: number,
        trx: Knex.Transaction
    ): Promise<void> {
        // Skip if already projecting for this pre_event_id (deduplication)
        const preEventKey = String(preEventId);
        if (positionProjectionInProgress.has(preEventKey)) {
            return;
        }
        positionProjectionInProgress.add(preEventKey);

        try {
            // Lock pre-event row to prevent concurrent projector races
            const preEvent = await PreEventRepository.lockForProjection(preEventId, trx);
            if (!preEvent) {
                logger.warn('Pre-event not found for positions projection', { preEventId });
                return;
            }

            // Get eligible provider IDs
            const eligibleProviderIds = PreEventRepository.getEligibleProviderIds(preEvent);
            if (eligibleProviderIds.length === 0) {
                logger.debug('No eligible providers for positions projection', { preEventId });
                return;
            }

            // Load all provider participants for this pre-event from eligible providers
            const providerParticipants = await EventParticipantRepository.getProviderParticipantsByPreEventId(
                preEventId,
                eligibleProviderIds,
                trx
            );

            if (providerParticipants.length === 0) {
                logger.debug('No provider participants found for positions projection', { preEventId });
                return;
            }

            // Group by pre_event_participant_id
            const participantsByPreId: Record<number, any[]> = {};
            for (const pp of providerParticipants) {
                const preParticipantId = pp.pre_event_participant_id;
                if (!participantsByPreId[preParticipantId]) {
                    participantsByPreId[preParticipantId] = [];
                }
                participantsByPreId[preParticipantId].push(pp);
            }

            // Calculate provider completeness (count of non-null positions per provider)
            const providerCompleteness: Record<number, number> = {};
            for (const pp of providerParticipants) {
                if (pp.position != null) {
                    providerCompleteness[pp.provider_id] = (providerCompleteness[pp.provider_id] || 0) + 1;
                }
            }

            // Select best provider (highest completeness)
            let selectedProviderId: number | null = null;
            let maxCompleteness = 0;
            for (const [providerId, completeness] of Object.entries(providerCompleteness)) {
                if (completeness > maxCompleteness) {
                    maxCompleteness = completeness;
                    selectedProviderId = Number(providerId);
                }
            }

            if (!selectedProviderId) {
                logger.debug('No provider has positions to project', { preEventId });
                return;
            }

            logger.debug('Selected provider for positions projection', {
                preEventId,
                selectedProviderId,
                completeness: maxCompleteness,
                totalProviders: Object.keys(providerCompleteness).length
            });

            // Update each pre participant's position
            let updatedCount = 0;
            for (const [preParticipantIdStr, providerParts] of Object.entries(participantsByPreId)) {
                const preParticipantId = Number(preParticipantIdStr);

                // Find the selected provider's participant
                const selectedProviderParticipant = providerParts.find(
                    pp => pp.provider_id === selectedProviderId
                );

                if (!selectedProviderParticipant || selectedProviderParticipant.position == null) {
                    continue;
                }

                // Get current pre participant
                const preParticipant = await PreEventParticipantRepository.getById(preParticipantId, trx);
                if (!preParticipant) {
                    continue;
                }

                const newPosition = selectedProviderParticipant.position;
                const currentPosition = preParticipant.position;
                const currentSourceProviderId = preParticipant.position_source_provider_id;

                // Determine if we should update
                let shouldUpdate = false;

                if (currentPosition == null) {
                    // Pre position is null -> set it
                    shouldUpdate = true;
                } else if (currentPosition !== newPosition) {
                    // Position differs - update if source matches or completeness is >= current
                    if (currentSourceProviderId === selectedProviderId) {
                        // Same source provider - trust the update
                        shouldUpdate = true;
                    } else {
                        // Different source - check if selected provider has >= completeness
                        const currentSourceCompleteness = providerCompleteness[currentSourceProviderId] || 0;
                        if (maxCompleteness >= currentSourceCompleteness) {
                            shouldUpdate = true;
                        }
                    }
                }

                if (shouldUpdate) {
                    await PreEventParticipantRepository.updatePosition(
                        preParticipantId,
                        newPosition,
                        selectedProviderId,
                        trx
                    );
                    updatedCount++;
                }
            }

            logger.debug('Positions projection completed', {
                preEventId,
                selectedProviderId,
                updatedCount
            });

        } catch (error) {
            logger.error('Error projecting positions', error as Error, { preEventId });
            throw error;
        } finally {
            positionProjectionInProgress.delete(preEventKey);
        }
    }

    /**
     * Ensure monitoring_started_at is set on the pre-event
     * Only updates if currently null
     * 
     * @param preEventId - The pre-event ID
     * @param trx - Transaction (required)
     */
    static async ensureMonitoringStarted(
        preEventId: number,
        trx: Knex.Transaction
    ): Promise<void> {
        void preEventId;
        void trx;
        return;
        try {
            const updated = await PreEventRepository.ensureMonitoringStarted(preEventId, trx);
            if (updated) {
                logger.debug('Monitoring started timestamp set', { preEventId });
            }
        } catch (error) {
            logger.error('Error ensuring monitoring started', error as Error, { preEventId });
            throw error;
        }
    }

    /**
     * Check conditions and set monitoring_ended_at if all are met
     * 
     * Conditions:
     * A) display_dividend_info IS NOT NULL and != '{}'
     * B) All active pre participants have position IS NOT NULL
     * C) All active pre participants have SP in pre_odds.display_odds
     * D) At least 2 distinct eligible providers have monitoring_ended_at IS NOT NULL
     * 
     * @param preEventId - The pre-event ID
     * @param trx - Transaction (required)
     */
    static async checkAndSetMonitoringEnded(
        preEventId: number,
        trx: Knex.Transaction
    ): Promise<void> {
        void preEventId;
        void trx;
        return;
        // Skip if already checking for this pre_event_id (deduplication)
        const monitoringKey = String(preEventId);
        if (monitoringEndedCheckInProgress.has(monitoringKey)) {
            return;
        }
        monitoringEndedCheckInProgress.add(monitoringKey);

        try {
            // Lock pre-event row
            const preEvent = await PreEventRepository.lockForProjection(preEventId, trx);
            if (!preEvent) {
                logger.warn('Pre-event not found for monitoring ended check', { preEventId });
                return;
            }

            // Skip if already set (we don't regress)
            // Note: We allow updating to a later timestamp

            // Get eligible provider IDs
            const eligibleProviderIds = PreEventRepository.getEligibleProviderIds(preEvent);
            if (eligibleProviderIds.length < 2) {
                // Need at least 2 providers for condition D
                return;
            }

            // Condition A: display_dividend_info present
            const displayDividendInfo = preEvent.display_dividend_info;
            const hasDividendInfo = displayDividendInfo != null &&
                JSON.stringify(displayDividendInfo) !== '{}' &&
                JSON.stringify(displayDividendInfo) !== 'null';

            if (!hasDividendInfo) {
                logger.debug('Monitoring ended check: display_dividend_info not ready', { preEventId });
                return;
            }

            // Condition B: All active pre participants have positions
            const activeParticipants = await PreEventParticipantRepository.getAllActiveByPreEventId(
                preEventId,
                trx
            );

            if (activeParticipants.length === 0) {
                logger.debug('Monitoring ended check: no active participants', { preEventId });
                return;
            }

            const participantsWithoutPosition = activeParticipants.filter(p => p.position == null);
            if (participantsWithoutPosition.length > 0) {
                logger.debug('Monitoring ended check: positions not complete', {
                    preEventId,
                    missingCount: participantsWithoutPosition.length
                });
                return;
            }

            if (getSportAdapter().hooks.odds.supportsStartingPrice()) {
                const participantIds = activeParticipants.map(p => p.id);
                const participantsWithoutSp = await this.checkParticipantsHaveSp(
                    preEventId,
                    participantIds,
                    trx
                );

                if (participantsWithoutSp.length > 0) {
                    logger.debug('Monitoring ended check: SPs not ready', {
                        preEventId,
                        missingCount: participantsWithoutSp.length
                    });
                    return;
                }
            }

            // Condition D: At least 2 distinct eligible providers have monitoring_ended_at
            const endedProviders = await this.getEndedProviders(
                preEventId,
                eligibleProviderIds,
                trx
            );

            if (endedProviders.length < 2) {
                logger.debug('Monitoring ended check: not enough providers ended', {
                    preEventId,
                    endedCount: endedProviders.length
                });
                return;
            }

            // All conditions met - compute MAX(monitoring_ended_at)
            const maxEndedAt = endedProviders.reduce((max, p) => {
                const ended = new Date(p.monitoring_ended_at);
                return ended > max ? ended : max;
            }, new Date(0));

            // Update pre.monitoring_ended_at
            const updated = await PreEventRepository.updateMonitoringEndedAt(
                preEventId,
                maxEndedAt,
                trx
            );

            if (updated) {
                logger.info('Monitoring ended timestamp set', {
                    preEventId,
                    monitoringEndedAt: maxEndedAt,
                    endedProvidersCount: endedProviders.length
                });
            }

        } catch (error) {
            logger.error('Error checking/setting monitoring ended', error as Error, { preEventId });
            throw error;
        } finally {
            monitoringEndedCheckInProgress.delete(monitoringKey);
        }
    }

    /**
     * Check which active participants don't have SP in their pre_odds.display_odds
     * 
     * @param preEventId - The pre-event ID
     * @param participantIds - Array of pre-event participant IDs to check
     * @param trx - Transaction
     * @returns Array of participant IDs without SP
     */
    private static async checkParticipantsHaveSp(
        preEventId: number,
        participantIds: number[],
        trx: Knex.Transaction
    ): Promise<number[]> {
        if (participantIds.length === 0) {
            return [];
        }

        // Query pre_odds to find participants without SP in display_odds
        // SP is stored in display_odds->'sp'
        const participantsWithoutSp = await trx.raw(`
            SELECT pep.id
            FROM ${TABLES.PRE_EVENT_PARTICIPANTS} pep
            WHERE pep.id = ANY(?)
            AND pep.event_id = ?
            AND NOT EXISTS (
                SELECT 1 FROM ${TABLES.PRE_ODDS} po
                WHERE po.event_entry_id = pep.id
                AND po.display_odds IS NOT NULL
                AND po.display_odds->'sp' IS NOT NULL
                AND po.display_odds->>'sp' != 'null'
            )
        `, [participantIds, preEventId]);

        return participantsWithoutSp.rows.map((r: any) => r.id);
    }

    /**
     * Get provider events that have monitoring_ended_at set
     * 
     * @param preEventId - The pre-event ID
     * @param eligibleProviderIds - Array of eligible provider IDs
     * @param trx - Transaction
     * @returns Array of provider events with monitoring_ended_at
     */
    private static async getEndedProviders(
        preEventId: number,
        eligibleProviderIds: number[],
        trx: Knex.Transaction
    ): Promise<any[]> {
        if (eligibleProviderIds.length === 0) {
            return [];
        }

        return await trx(TABLES.PROVIDER_EVENTS)
            .where('pre_event_id', preEventId)
            .whereIn('provider_id', eligibleProviderIds)
            .whereNotNull('monitoring_ended_at')
            .select('provider_id', 'monitoring_ended_at');
    }
}

