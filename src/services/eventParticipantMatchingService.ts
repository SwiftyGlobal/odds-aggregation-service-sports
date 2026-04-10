/**
 * Event Participant Matching Service
 * Handles matching of provider event participants to pre-event participants
 * 
 * With the removal of the participants table, event participants are now matched directly
 * based on event + ref_id without needing a separate participant entity.
 */

import { KnexClient } from '../config/knex.js';
import { logger } from '../utils/logger.js';
import { EventParticipantRepository } from '../repositories/eventParticipantRepository.js';
import { PreEventParticipantRepository } from '../repositories/preEventParticipantRepository.js';
import { EnsureService } from './ensureService.js';
import { DbConcurrencyManager } from '../utils/dbConcurrencyManager.js';
import { buildParticipantRefId, extractParticipantName } from '../utils/refIdUtils.js';
import { PreEventCoverageService } from './preEventCoverageService.js';
import { PreEventOutboxService } from './preEventOutboxService.js';
import { OddsAggregationService } from './oddsAggregationService.js';
import { TABLES } from '../constants/tables.js';
import { getSportAdapter } from '../adapters/index.js';

export interface EventParticipantMatchResult {
    preEventParticipantId: number;
    isNew: boolean;
    confidence: number;
    matchReason: string;
}

export class EventParticipantMatchingService {
    private static db = KnexClient.getInstance();

    /**
     * Process event participant change
     * Checks if pre_event_participant_id is null and matches/creates if needed
     */
    static async processEventParticipantChange(
        providerEventParticipantId: number,
        lsn: string,
        trx?: any
    ): Promise<void> {
        const operationId = `participant-${providerEventParticipantId}-${lsn}`;

        // If transaction is provided, use it directly (no concurrency control needed)
        if (trx) {
            await this.executeEventParticipantChange(providerEventParticipantId, lsn, trx);
            return;
        }

        // Acquire DB slot for concurrency control
        await DbConcurrencyManager.acquireDbSlot(operationId);

        try {
            const matchResult = await KnexClient.withRetryableTransaction(async (transaction) => {
                return await this.executeEventParticipantChange(providerEventParticipantId, lsn, transaction);
            });

            if (matchResult?.preEventId && matchResult?.preEventParticipantId) {
                await OddsAggregationService.aggregateOddsForParticipant(
                    matchResult.preEventId,
                    matchResult.preEventParticipantId
                );
            }
        } finally {
            DbConcurrencyManager.releaseDbSlot(operationId);
        }
    }

    /**
     * Execute event participant change processing logic
     */
    private static async executeEventParticipantChange(
        providerEventParticipantId: number,
        lsn: string,
        transaction: any
    ): Promise<{ preEventId: number; preEventParticipantId: number } | null> {
        try {
            // Load provider event participant from database
            const providerEventParticipant = await EventParticipantRepository.getProviderEventParticipant(
                providerEventParticipantId,
                transaction
            );

            if (!providerEventParticipant) {
                logger.warn('Provider event participant not found', { providerEventParticipantId });
                return null;
            }

            // Skip if already matched
            if (providerEventParticipant.pre_event_participant_id) {
                logger.debug('Event participant already matched', {
                    providerEventParticipantId,
                    preEventParticipantId: providerEventParticipant.pre_event_participant_id
                });
                return null;
            }

            logger.info('Processing event participant change', {
                providerEventParticipantId,
                participantName: providerEventParticipant.display_name,
                participantRefId: providerEventParticipant.participant_ref_id,
                drawNumber: providerEventParticipant.draw_number,
                providerEventId: providerEventParticipant.provider_event_id
            });

            // Ensure parent event is matched (on-the-fly matching)
            const preEventId = await EnsureService.ensurePreEventFromProvider(
                providerEventParticipant.provider_event_id,
                transaction
            );

            // Create or find pre-event-participant directly
            const result = await this.processDirectMatch(
                providerEventParticipant,
                preEventId,
                transaction
            );

            // Update provider event participant with the pre_event_participant_id
            await EventParticipantRepository.updatePreEventParticipantId(
                providerEventParticipantId,
                result.preEventParticipantId,
                transaction
            );

            logger.info('Event participant matched and linked', {
                providerEventParticipantId,
                preEventParticipantId: result.preEventParticipantId,
                preEventId: preEventId,
                isNew: result.isNew,
                confidence: result.confidence,
                matchReason: result.matchReason,
                lsn
            });

            // Update pre-event coverage tracking
            await PreEventCoverageService.updatePreEventCoverage(preEventId, transaction);
            await PreEventOutboxService.emitIfNeeded(preEventId, transaction, { force: true });

            return { preEventId, preEventParticipantId: result.preEventParticipantId };

        } catch (error) {
            logger.error('Error processing event participant change', error as Error, {
                providerEventParticipantId,
                lsn
            });
            throw error;
        }
    }

    /**
     * Direct matching of event participant to pre-event-participant
     * Uses ref_id + pre_event_id for uniqueness
     */
    private static async processDirectMatch(
        providerEventParticipant: any,
        preEventId: number,
        trx: any
    ): Promise<EventParticipantMatchResult> {
        // Build the canonical ref_id to look up existing pre-event-participant
        // Always run through extractParticipantName() to handle cases where slug/display_name
        // contain full provider ref_ids (e.g. "202603051900.T.GBR.newcastle.6.castan")
        const rawName = providerEventParticipant.slug || providerEventParticipant.display_name || providerEventParticipant.participant_ref_id;
        const participantName = extractParticipantName(rawName);
        const parentEvent = await trx(TABLES.PRE_EVENTS)
            .where('id', preEventId)
            .select('event_ref_id')
            .first();

        const canonicalRefId = (parentEvent?.event_ref_id && participantName)
            ? buildParticipantRefId(parentEvent.event_ref_id, participantName)
            : providerEventParticipant.participant_ref_id;

        // Get existing pre-event-participant if it exists
        const existingPreEventParticipant = await PreEventParticipantRepository.getPreEventParticipant(
            preEventId,
            canonicalRefId,
            trx
        );

        // Start with existing extra_info if available, otherwise start fresh
        const extraInfo: Record<string, any> = {};
        if (existingPreEventParticipant?.extra_info) {
            try {
                const existing = typeof existingPreEventParticipant.extra_info === 'string'
                    ? JSON.parse(existingPreEventParticipant.extra_info)
                    : existingPreEventParticipant.extra_info;
                Object.assign(extraInfo, existing);
                // Remove old silk_paths field if it exists (we're using silk_info now)
                delete extraInfo.silk_paths;
            } catch (e) {
                // Ignore parse errors
            }
        }

        // Merge in provider event participant's extra_info (excluding silk_path and silk_url which we'll handle separately)
        if (providerEventParticipant.extra_info) {
            try {
                const providerExtraInfo = typeof providerEventParticipant.extra_info === 'string'
                    ? JSON.parse(providerEventParticipant.extra_info)
                    : providerEventParticipant.extra_info;

                // Merge all fields except silk_path and silk_url (we'll aggregate those separately)
                const { silk_path, silk_url, ...providerExtraInfoWithoutSilk } = providerExtraInfo;
                Object.assign(extraInfo, providerExtraInfoWithoutSilk);
            } catch (e) {
                // Ignore parse errors
            }
        }

        // Update provider_mappings - check if this provider is already mapped
        extraInfo.provider_mappings = extraInfo.provider_mappings || [];
        const existingMappingIndex = extraInfo.provider_mappings.findIndex(
            (m: any) => m.provider_id === providerEventParticipant.provider_id
        );

        const newMapping = {
            provider_id: providerEventParticipant.provider_id,
            participant_ref_id: providerEventParticipant.participant_ref_id,
            matched_at: new Date().toISOString()
        };

        if (existingMappingIndex >= 0) {
            // Update existing mapping
            extraInfo.provider_mappings[existingMappingIndex] = newMapping;
        } else {
            // Add new mapping
            extraInfo.provider_mappings.push(newMapping);
        }

        // Aggregate all silk_path and silk_url from all providers for this pre-event-participant
        const allProviderParticipants = await EventParticipantRepository.getProviderEventParticipantsForPreEventParticipant(
            providerEventParticipant.participant_ref_id,
            preEventId,
            trx
        );

        const silkInfo: Array<{ provider_id: number; silk_path?: string; silk_url?: string }> = [];
        for (const providerParticipant of allProviderParticipants) {
            if (providerParticipant.extra_info) {
                try {
                    const providerExtraInfo = typeof providerParticipant.extra_info === 'string'
                        ? JSON.parse(providerParticipant.extra_info)
                        : providerParticipant.extra_info;

                    // Include entry if either silk_path or silk_url exists
                    if (providerExtraInfo.silk_path || providerExtraInfo.silk_url) {
                        const silkEntry: { provider_id: number; silk_path?: string; silk_url?: string } = {
                            provider_id: providerParticipant.provider_id
                        };

                        if (providerExtraInfo.silk_path) {
                            silkEntry.silk_path = providerExtraInfo.silk_path;
                        }

                        if (providerExtraInfo.silk_url) {
                            silkEntry.silk_url = providerExtraInfo.silk_url;
                        }

                        silkInfo.push(silkEntry);
                    }
                } catch (e) {
                    // Ignore parse errors
                }
            }
        }

        // Always set silk_info (even if empty array) to ensure it's updated
        extraInfo.silk_info = silkInfo;

        // Create or update pre-event-participant
        // ref_id is auto-generated inside the repository from event ref_id + participant name
        const adapter = getSportAdapter();
        const participantData: any = {
            pre_event_id: preEventId,
            provider_participant_ref_id: providerEventParticipant.participant_ref_id,
            display_name: providerEventParticipant.display_name,
            slug: providerEventParticipant.participant_ref_id,
            position: providerEventParticipant.position,
            extra_info: JSON.stringify(extraInfo),
            // Propagate canonical-entry fields from provider layer -> pre layer.
            // Undefined values are skipped by the repository (existing canonical
            // row keeps whatever the previous provider wrote). Last provider to
            // touch the row wins for status / role / seed / positions.
            entry_status: providerEventParticipant.entry_status,
            role: providerEventParticipant.role,
            seed: providerEventParticipant.seed,
            draw_position: providerEventParticipant.draw_position,
            finishing_position: providerEventParticipant.finishing_position,
        };
        adapter.hooks.participant.applyPreEventParticipantFields({
            data: {
                participant_status_id: providerEventParticipant.participant_status_id,
                draw_number: providerEventParticipant.draw_number,
                jockey: providerEventParticipant.jockey,
            },
            insertData: participantData,
            mergeData: participantData,
        });

        const preEventParticipantId = await PreEventParticipantRepository.createOrUpdatePreEventParticipant(
            participantData,
            trx
        );

        return {
            preEventParticipantId,
            isNew: true, // We use upsert, so we don't track this precisely
            confidence: 1.0,
            matchReason: 'direct_match_by_ref_id'
        };
    }
}
