/**
 * Odds Processing Service - Handles odds aggregation and processing
 * Focused on odds-specific processing logic
 */

import { DatabaseService } from '../utils/database.js';
import { logger } from '../utils/logger.js';
import { EventRepository } from '../repositories/eventRepository.js';
import { PreEventParticipantRepository } from '../repositories/preEventParticipantRepository.js';
import { PreEventRepository } from '../repositories/preEventRepository.js';
import { MarketTypeRepository } from '../repositories/marketTypeRepository.js';
import { MarketRepository } from '../repositories/marketRepository.js';
import { EventParticipantRepository } from '../repositories/eventParticipantRepository.js';
import { OddsRepository } from '../repositories/oddsRepository.js';
import { PreOddsRepository } from '../repositories/preOddsRepository.js';
import { OutboxRepository } from '../repositories/outboxRepository.js';
import { PreEventCoverageService } from './preEventCoverageService.js';
import { SPORT_IDS } from '../constants/sports.js';
import { TABLES } from '../constants/tables.js';
import { getSportAdapter } from '../adapters/index.js';
import { ODDS_MARGIN_CONFIG } from '../config/index.js';
import { removeOutliers, calculateMean, ProviderOddsCandidate } from '../utils/outlierRemoval.js';
import { snapToLadder } from '../utils/oddsLadder.js';
import { OUTBOX_EVENT_TYPES } from '../constants/outbox.js';
import { buildPreOddsDeltaPayload, buildSelectionKey } from '../utils/outboxPayloadBuilder.js';
import { PreEventOutboxService } from './preEventOutboxService.js';

export class OddsProcessingService {
    private static db = DatabaseService.getInstance();

    /**
     * Process odds updated
     */
    static async processOddsUpdated(data: any): Promise<void> {
        logger.debug('Processing odds update notification', {
            providerId: data.providerId,
            providerName: data.providerName,
            eventRefId: data.eventRefId
        });

        try {
            // Read event and odds data from database (source of truth)
            const providerEvent = await EventRepository.getByProviderAndRefId(
                data.providerId,
                data.eventRefId
            );

            if (!providerEvent || !providerEvent.pre_event_id) {
                logger.debug('No pre-event linked for odds update', {
                    providerId: data.providerId,
                    eventRefId: data.eventRefId
                });
                return;
            }

            // Trigger odds re-aggregation for this event
            await this.reAggregateEventOdds(providerEvent.pre_event_id);

            // Update pre-event coverage tracking (odds_available may have changed)
            await PreEventCoverageService.updatePreEventCoverage(providerEvent.pre_event_id);

        } catch (error) {
            logger.error('Error handling odds updated', error as Error, {
                providerId: data.providerId,
                eventRefId: data.eventRefId
            });
            throw error;
        }
    }

    /**
     * Process batch odds updated
     */
    static async processBatchOddsUpdated(data: any): Promise<void> {
        logger.debug('Processing batch odds update', {
            providerId: data.providerId,
            eventRefId: data.eventRefId,
            oddsCount: data.oddsUpdates?.length || 0
        });

        // Similar to processOddsUpdated but for multiple odds at once
        await this.processOddsUpdated(data);
    }

    /**
     * Re-aggregate odds for a specific event
     */
    private static async reAggregateEventOdds(preEventId: number): Promise<void> {
        logger.debug('Re-aggregating odds for event', { preEventId });

        try {
            await this.aggregateOddsForEvent(preEventId);
        } catch (error) {
            logger.error('Failed to re-aggregate odds for event', error as Error, { preEventId });
            throw error;
        }
    }

    /**
     * Aggregate odds for a specific pre-event
     */
    private static async aggregateOddsForEvent(preEventId: number): Promise<void> {
        logger.debug('Starting odds aggregation for event', { preEventId });

        try {
            // Get all provider events linked to this pre-event
            const allProviderEvents = await EventRepository.getProviderEventsByPreEventId(preEventId);
            const providerEvents = allProviderEvents.filter(e => e.auto_sync === true);

            if (providerEvents.length === 0) {
                logger.warn('No provider events found for pre-event', { preEventId });
                return;
            }

            // Get all pre-event participants for this event
            const preEventParticipants = await PreEventParticipantRepository.getByPreEventId(preEventId);

            if (preEventParticipants.length === 0) {
                logger.warn('No pre-event participants found for event', { preEventId });
                return;
            }

            // Get all pre-markets for this event
            const preMarkets = await MarketRepository.getPreMarketsByEvent(preEventId);

            if (preMarkets.length === 0) {
                logger.warn('No pre-markets found for event', { preEventId });
                return;
            }

            // Aggregate odds for each participant and market combination
            for (const participant of preEventParticipants) {
                const canonicalOptionKey = participant.ref_id || String(participant.id);
                console.log('---------------------------------------------------------canonicalOptionKey', canonicalOptionKey);

                for (const preMarket of preMarkets) {
                    await this.aggregateParticipantMarketOdds(
                        preEventId,
                        participant.id,
                        canonicalOptionKey,
                        preMarket.id,
                        providerEvents
                    );
                }
            }

            logger.info('Odds aggregation completed for event', {
                preEventId,
                participantCount: preEventParticipants.length,
                preMarketCount: preMarkets.length,
                providerCount: providerEvents.length
            });

        } catch (error) {
            logger.error('Failed to aggregate odds for event', error as Error, { preEventId });
            throw error;
        }
    }

    /**
     * Aggregate odds for a specific participant and market
     */
    private static async aggregateParticipantMarketOdds(
        preEventId: number,
        preEventParticipantId: number,
        canonicalOptionKey: string,
        preMarketId: number,
        providerEvents: any[]
    ): Promise<void> {
        try {
            // Get all provider odds for this participant and market across all providers
            const allOdds = [];
            const cutoffTime = new Date(Date.now() - (24 * 60 * 60 * 1000)); // 24 hours ago

            // Get all provider_markets linked to this pre_market
            const providerMarkets = await MarketRepository.getProviderMarketsByPreMarket(preMarketId);

            for (const providerEvent of providerEvents) {
                // Get provider event participants linked to this pre-event participant
                const providerEventParticipants = await EventParticipantRepository.getByProviderEventAndPreParticipant(
                    providerEvent.id,
                    preEventParticipantId
                );

                for (const providerEventParticipant of providerEventParticipants) {
                    // Find provider_market for this provider's event
                    const providerMarket = providerMarkets.find(
                        (pm: any) => pm.provider_id === providerEvent.provider_id
                    );

                    if (!providerMarket) {
                        logger.debug('No provider market found for pre-market', {
                            preMarketId,
                            providerId: providerEvent.provider_id
                        });
                        continue;
                    }

                    const odds = await OddsRepository.getByMarketAndParticipantWithCutoff(
                        providerMarket.id,
                        providerEventParticipant.id,
                        cutoffTime
                    );

                    for (const odd of odds) {
                        // Odds field is now decimal(10,2) - read directly as number
                        if (odd.odds != null && typeof odd.odds === 'number' && odd.odds > 1.0) {
                            allOdds.push({
                                providerId: providerEvent.provider_id,
                                odds: odd.odds,
                                displayOdds: odd.display_odds,
                                lastUpdated: odd.updated_at
                            });
                        }
                    }
                }
            }

            if (allOdds.length === 0) {
                logger.debug('No valid odds found for participant and market', {
                    preEventId,
                    preEventParticipantId,
                    preMarketId,
                    canonicalOptionKey
                });
                return;
            }

            // Build candidates for outlier removal
            const candidates: ProviderOddsCandidate[] = allOdds.map(o => ({
                providerId: o.providerId,
                decimal: o.odds
            }));

            // Remove outliers
            const { included, outliers } = removeOutliers(
                candidates,
                ODDS_MARGIN_CONFIG.outlierTolerancePct
            );

            const includedProviderIds = included.map(c => c.providerId);
            const outlierProviderIds = outliers.map(c => c.providerId);
            const includedDecimals = included.map(c => c.decimal);

            // Calculate average from included providers only
            const averageOdds = calculateMean(includedDecimals);

            if (averageOdds === null) {
                logger.debug('Failed to calculate average odds', {
                    preEventId,
                    preEventParticipantId,
                    preMarketId,
                    canonicalOptionKey
                });
                return;
            }

            // Create provider odds record
            const providerOdds: Record<number, any> = {};
            allOdds.forEach(odd => {
                providerOdds[odd.providerId] = {
                    odds: odd.odds,
                    displayOdds: odd.displayOdds,
                    lastUpdated: odd.lastUpdated
                };
            });

            // Save or update aggregated odds
            await this.saveAggregatedOdds({
                preEventId,
                preEventParticipantId,
                preMarketId,
                canonicalOptionKey,
                averageOdds,
                providerCount: included.length,
                providerOdds,
                displayOddsProviderIds: includedProviderIds,
                outlierOddsProviderIds: outlierProviderIds
            });

            logger.debug('Odds aggregated for participant and market', {
                preEventId,
                preEventParticipantId,
                preMarketId,
                canonicalOptionKey,
                averageOdds,
                providerCount: included.length,
                includedProviderIds,
                outlierProviderIds
            });

        } catch (error) {
            logger.error('Failed to aggregate participant market odds', error as Error, {
                preEventId,
                preEventParticipantId,
                preMarketId,
                canonicalOptionKey
            });
            throw error;
        }
    }

    /**
     * Save aggregated odds to database
     */
    private static async saveAggregatedOdds(data: {
        preEventId: number;
        preEventParticipantId: number;
        preMarketId: number;
        canonicalOptionKey: string;
        averageOdds: number;
        providerCount: number;
        providerOdds: any;
        displayOddsProviderIds: number[];
        outlierOddsProviderIds: number[];
    }): Promise<void> {
        // Apply margin and snap to ladder for display_odds
        const marginPct = ODDS_MARGIN_CONFIG.marginPct;
        const displayDecimalRaw = data.averageOdds / (1 + marginPct);
        const snapped = snapToLadder(displayDecimalRaw);

        const displayOddsJson = {
            decimal: snapped.decimal,
            fractional: snapped.fractional,
            as_of: new Date().toISOString()
        };

        // Check if odds already exist
        const existingOdds = await PreOddsRepository.getPreOdds(
            data.preMarketId,
            data.canonicalOptionKey
        );

        if (existingOdds) {
            // Check if odds have changed significantly
            const oddsChanged =
                Math.abs(existingOdds.average_odds - data.averageOdds) > 0.01 ||
                existingOdds.provider_count !== data.providerCount;

            if (oddsChanged) {
                // Update existing odds (history creation is driven only by provider history events)
                await DatabaseService.withRetryableTransaction(async (transaction) => {
                    const preOddsRow = await PreOddsRepository.createOrUpdatePreOdds(
                        {
                            pre_event_id: data.preEventId,
                            pre_market_id: data.preMarketId,
                            option_key: data.canonicalOptionKey,
                            pre_event_participant_id: data.preEventParticipantId,
                            average_odds: data.averageOdds,
                            provider_count: data.providerCount,
                            provider_odds: JSON.stringify(data.providerOdds),
                            display_odds: JSON.stringify(displayOddsJson),
                            display_odds_provider_ids: data.displayOddsProviderIds,
                            outlier_odds_provider_ids: data.outlierOddsProviderIds,
                            active: true,
                            last_updated: new Date()
                        },
                        transaction
                    );

                    await this.publishPreOddsOutbox(
                        preOddsRow,
                        data.preEventId,
                        data.preMarketId,
                        data.canonicalOptionKey,
                        transaction
                    );
                });

                logger.debug('Odds updated (no history on update)', {
                    preEventId: data.preEventId,
                    preEventParticipantId: data.preEventParticipantId,
                    preMarketId: data.preMarketId,
                    canonicalOptionKey: data.canonicalOptionKey,
                    averageOdds: data.averageOdds,
                    displayOdds: snapped.decimal
                });
            }
        } else {
            // Insert new odds with proper upsert logic (do not create history row here).
            await DatabaseService.withRetryableTransaction(async (transaction) => {
                const preOddsRow = await PreOddsRepository.createOrUpdatePreOdds(
                    {
                        pre_event_id: data.preEventId,
                        pre_market_id: data.preMarketId,
                        option_key: data.canonicalOptionKey,
                        pre_event_participant_id: data.preEventParticipantId,
                        average_odds: data.averageOdds,
                        provider_count: data.providerCount,
                        provider_odds: JSON.stringify(data.providerOdds),
                        display_odds: JSON.stringify(displayOddsJson),
                        display_odds_provider_ids: data.displayOddsProviderIds,
                        outlier_odds_provider_ids: data.outlierOddsProviderIds,
                        active: true,
                        last_updated: new Date()
                    },
                    transaction
                );

                await this.publishPreOddsOutbox(
                    preOddsRow,
                    data.preEventId,
                    data.preMarketId,
                    data.canonicalOptionKey,
                    transaction
                );
            });

            logger.debug('New odds created/updated (no history on insert)', {
                preEventId: data.preEventId,
                preEventParticipantId: data.preEventParticipantId,
                preMarketId: data.preMarketId,
                canonicalOptionKey: data.canonicalOptionKey,
                averageOdds: data.averageOdds,
                displayOdds: snapped.decimal
            });
        }
    }

    private static async publishPreOddsOutbox(
        preOddsRow: any,
        preEventId: number,
        preMarketId: number,
        optionKey: string,
        transaction: any
    ): Promise<void> {
        if (!preOddsRow) {
            return;
        }

        const preEvent = await PreEventRepository.getPreEvent(preEventId, transaction);
        if (!preEvent || !preEvent.event_snapshot_version || preEvent.event_snapshot_version < 1) {
            return;
        }

        const selectionKey = buildSelectionKey(preMarketId, optionKey);

        const payload = buildPreOddsDeltaPayload({
            preOdds: preOddsRow,
            selectionKey
        });

        await OutboxRepository.insertOutboxEvent(
            {
                event_type: OUTBOX_EVENT_TYPES.PRE_ODDS_DELTA,
                aggregate_key: selectionKey,
                payload,
                version: preOddsRow.version ?? 1
            },
            transaction
        );

        await PreEventOutboxService.emitIfNeeded(preEventId, transaction);
    }

    /**
     * Parse decimal odds from various formats
     */
    private static parseDecimalOdds(odds: string): number | null {
        try {
            // Handle fractional odds (e.g., "5/2" = 3.5)
            if (odds.includes('/')) {
                const parts = odds.split('/');
                if (parts.length !== 2 || !parts[0] || !parts[1]) {
                    return null;
                }
                const numerator = parseFloat(parts[0]);
                const denominator = parseFloat(parts[1]);

                if (isNaN(numerator) || isNaN(denominator) || denominator === 0) {
                    return null;
                }

                return numerator / denominator + 1;
            }

            // Handle decimal odds
            const decimal = parseFloat(odds);
            return isNaN(decimal) ? null : decimal;
        } catch {
            return null;
        }
    }

    /**
     * Calculate average of decimal odds
     */
    private static calculateAverage(odds: number[]): number {
        if (odds.length === 0) return 0;
        return odds.reduce((sum, odd) => sum + odd, 0) / odds.length;
    }

    /**
     * Process existing odds history from provider layer to pre-layer
     */
    static async processExistingOddsHistory(preEventId: number): Promise<void> {
        logger.debug('Processing existing odds history for pre-event', { preEventId });

        try {
            // Get all pre-odds for this event
            const preOdds = await PreOddsRepository.getPreOddsByEvent(preEventId);

            for (const preOdd of preOdds) {
                // Build a set of existing timestamps for this pre-odds to ensure idempotency
                const existingHistoryRows = await this.db(TABLES.PRE_ODDS_HISTORY)
                    .where('pre_odds_id', preOdd.id)
                    .select('odds_timestamp');
                const existingTs = new Set<string>(
                    existingHistoryRows.map((r: any) => new Date(r.odds_timestamp).toISOString())
                );

                // Get the corresponding provider odds history rows for this participant/market
                // Construct provider odds history table name from adapter (not in TABLES constant)
                const adapter = getSportAdapter();
                const PROVIDER_ODDS_HISTORY =
                    adapter.tables.PROVIDER_ODDS_HISTORY
                    ?? `fs_provider_${adapter.hooks.metadata.getSportSlug()}_odds_history`;

                const providerOddsHistory = await this.db(PROVIDER_ODDS_HISTORY)
                    .join(TABLES.PROVIDER_ODDS, `${PROVIDER_ODDS_HISTORY}.provider_selection_id`, `${TABLES.PROVIDER_ODDS}.id`)
                    .join(TABLES.PROVIDER_EVENTS, `${TABLES.PROVIDER_ODDS}.provider_event_id`, `${TABLES.PROVIDER_EVENTS}.id`)
                    .join(TABLES.PROVIDER_MARKETS, `${TABLES.PROVIDER_ODDS}.provider_market_id`, `${TABLES.PROVIDER_MARKETS}.id`)
                    .leftJoin(TABLES.PROVIDER_EVENT_PARTICIPANTS, `${TABLES.PROVIDER_ODDS}.provider_event_entry_id`, `${TABLES.PROVIDER_EVENT_PARTICIPANTS}.id`)
                    .where(`${TABLES.PROVIDER_EVENTS}.pre_event_id`, preEventId)
                    .where(`${TABLES.PROVIDER_MARKETS}.pre_market_id`, preOdd.market_id)
                    .where(function() {
                        if (preOdd.event_entry_id) {
                            this.where(`${TABLES.PROVIDER_EVENT_PARTICIPANTS}.pre_event_entry_id`, preOdd.event_entry_id);
                        } else {
                            this.whereNull(`${TABLES.PROVIDER_ODDS}.provider_event_entry_id`);
                        }
                    })
                    .select(`${PROVIDER_ODDS_HISTORY}.*`, `${TABLES.PROVIDER_ODDS}.provider_id`)
                    .orderBy(`${PROVIDER_ODDS_HISTORY}.created_at`, 'asc');

                for (const h of providerOddsHistory) {
                    const tsIso = new Date(h.created_at).toISOString();
                    if (existingTs.has(tsIso)) {
                        continue; // already recorded
                    }

                    // Odds field is now decimal(10,2) - read directly as number
                    if (h.odds == null || typeof h.odds !== 'number') {
                        continue;
                    }
                    const dec = h.odds;

                    // Apply margin and snap to ladder for display_odds
                    const marginPct = ODDS_MARGIN_CONFIG.marginPct;
                    const displayDecimalRaw = dec / (1 + marginPct);
                    const snapped = snapToLadder(displayDecimalRaw);

                    const displayOddsJson = {
                        decimal: snapped.decimal,
                        fractional: snapped.fractional,
                        as_of: new Date(h.created_at).toISOString()
                    };

                    // Use actual provider_id from the joined provider odds row
                    const providerId = h.provider_id ?? 1;
                    const providerOdds = {
                        [providerId]: { odds: dec, displayOdds: h.odds, lastUpdated: h.created_at }
                    } as Record<number, any>;

                    await this.db(TABLES.PRE_ODDS_HISTORY)
                        .insert({
                            pre_selection_id: preOdd.id,
                            pre_event_id: preEventId,
                            price: dec,
                            display_price: JSON.stringify(displayOddsJson),
                            selection_status: 'active',
                            selection_outcome: 'pending',
                            recorded_at: h.created_at,
                            created_at: new Date()
                        });

                    existingTs.add(tsIso);
                }
            }

            logger.info('Completed processing existing odds history', {
                preEventId,
                preOddsCount: preOdds.length
            });

        } catch (error) {
            logger.error('Error processing existing odds history', error as Error, { preEventId });
            throw error;
        }
    }
}
