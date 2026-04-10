/**
 * Odds Aggregation Service
 * Handles odds aggregation from provider odds to pre-odds
 */

import { KnexClient } from '../config/knex.js';
import { logger } from '../utils/logger.js';
import { CONFIG, ODDS_MARGIN_CONFIG } from '../config/index.js';
import { OddsRepository } from '../repositories/oddsRepository.js';
import { PreOddsRepository } from '../repositories/preOddsRepository.js';
import { PreEventRepository } from '../repositories/preEventRepository.js';
import { MarketTypeRepository } from '../repositories/marketTypeRepository.js';
import { MarketRepository } from '../repositories/marketRepository.js';
import { EventRepository } from '../repositories/eventRepository.js';
import { EventParticipantRepository } from '../repositories/eventParticipantRepository.js';
import { PreEventParticipantRepository } from '../repositories/preEventParticipantRepository.js';
import { OutboxRepository } from '../repositories/outboxRepository.js';
import { EnsureService } from './ensureService.js';
import { OddsCalculation } from '../utils/oddsCalculation.js';
import { DbConcurrencyManager } from '../utils/dbConcurrencyManager.js';
import { determineOddsStatusFromChangeTime } from '../utils/oddsStatusUtils.js';
import { removeOutliers, calculateMean, ProviderOddsCandidate } from '../utils/outlierRemoval.js';
import { snapToLadder } from '../utils/oddsLadder.js';
import { getSportAdapter } from '../adapters/index.js';
import { OUTBOX_EVENT_TYPES } from '../constants/outbox.js';
import { buildPreOddsDeltaPayload, buildSelectionKey } from '../utils/outboxPayloadBuilder.js';
import { PreEventOutboxService } from './preEventOutboxService.js';
import { SPORT_IDS } from '../constants/sports.js';
import { Knex } from 'knex';

export class OddsAggregationService {
    /**
     * Process odds change (INSERT or UPDATE)
     */
    static async processOddsChange(
        providerOddsId: number,
        lsn: string,
        trx?: Knex.Transaction
    ): Promise<void> {
        const operationId = `odds-${providerOddsId}-${lsn}`;

        // If transaction is provided, use it directly (no concurrency control needed)
        if (trx) {
            return await this.executeOddsChange(providerOddsId, lsn, trx);
        }

        // Acquire DB slot for concurrency control
        await DbConcurrencyManager.acquireDbSlot(operationId);

        try {
            await KnexClient.withRetryableTransaction(async (transaction) => {
                await this.executeOddsChange(providerOddsId, lsn, transaction);
            });
        } finally {
            DbConcurrencyManager.releaseDbSlot(operationId);
        }
    }

    /**
     * Execute odds change processing logic
     */
    private static async executeOddsChange(
        providerOddsId: number,
        lsn: string,
        transaction: any
    ): Promise<void> {
        try {
            // Load provider odds from database
            const providerOdds = await OddsRepository.getProviderOdds(providerOddsId, transaction);

            if (!providerOdds) {
                logger.warn('Provider odds not found', { providerOddsId });
                return;
            }

            const adapter = getSportAdapter();

            logger.info('Processing odds change', {
                providerOddsId,
                providerEventId: providerOdds.provider_event_id,
                providerMarketId: providerOdds.provider_market_id,
                optionKey: providerOdds.option_key,
                odds: providerOdds.odds,
                oddsStatusId: providerOdds.odds_status_id,
                lsn
            });

            // Ensure parent event is matched (on-the-fly matching)
            const preEventId = await EnsureService.ensurePreEventFromProvider(
                providerOdds.provider_event_id,
                transaction
            );

            // Resolve pre_market_id from provider_market_id
            const preMarketId = await MarketRepository.getPreMarketId(
                providerOdds.provider_market_id,
                transaction
            );

            if (!preMarketId) {
                logger.warn('Provider market not matched to pre-market, skipping odds aggregation', {
                    providerOddsId,
                    providerMarketId: providerOdds.provider_market_id,
                    note: 'Will be processed when market is matched'
                });
                return;
            }

            // Resolve participant (if participant-based selection)
            let preEventParticipantId: number | null = null;
            let canonicalOptionKey: string;

            if (providerOdds.provider_event_participant_id) {
                const providerEventParticipant = await EventParticipantRepository.getProviderEventParticipant(
                    providerOdds.provider_event_participant_id,
                    transaction
                );

                if (!providerEventParticipant) {
                    logger.warn('Provider event participant not found', {
                        providerOddsId,
                        providerEventParticipantId: providerOdds.provider_event_participant_id
                    });
                    return;
                }

                const linkedEntryId =
                    providerEventParticipant.pre_event_entry_id ?? providerEventParticipant.pre_event_participant_id;
                if (!linkedEntryId) {
                    logger.info('Event participant not matched yet, skipping odds aggregation', {
                        providerOddsId,
                        providerEventParticipantId: providerOdds.provider_event_participant_id,
                        note: 'Will be processed when participant is matched'
                    });
                    return;
                }

                preEventParticipantId = linkedEntryId as number;

                const preParticipant = await PreEventParticipantRepository.getById(
                    preEventParticipantId,
                    transaction
                );
                canonicalOptionKey = preParticipant?.ref_id || String(preEventParticipantId);
            } else {
                // Non-participant selection (e.g., Draw) — option_key is canonical
                canonicalOptionKey = providerOdds.option_key;
            }

            logger.debug('Market resolved', {
                providerOddsId,
                providerMarketId: providerOdds.provider_market_id,
                preMarketId,
                canonicalOptionKey
            });

            logger.info('All dependencies matched, proceeding with aggregation', {
                providerOddsId,
                preEventId,
                preMarketId,
                canonicalOptionKey,
                preEventParticipantId
            });

            // Aggregate odds for this combination
            await this.aggregateOddsForCombination(
                preMarketId,
                canonicalOptionKey,
                preEventId,
                preEventParticipantId,
                transaction
            );

            logger.info('Odds aggregated successfully', {
                providerOddsId,
                preEventId,
                preMarketId,
                canonicalOptionKey,
                lsn
            });

        } catch (error) {
            logger.error('Error processing odds change', error as Error, {
                providerOddsId,
                lsn
            });
            throw error;
        }
    }

    /**
     * Aggregate odds for a specific combination (market + option key)
     */
    static async aggregateOddsForCombination(
        preMarketId: number,
        optionKey: string,
        preEventId: number,
        preEventParticipantId: number | null,
        trx?: Knex.Transaction
    ): Promise<void> {
        const execute = async (transaction: any) => {
            try {
                // Get all provider odds for this combination
                const allProviderOdds = await OddsRepository.getAllProviderOddsForPreMarket(
                    preMarketId,
                    preEventParticipantId,
                    CONFIG.oddsCalculation.maxAgeSeconds,
                    transaction
                );

                logger.debug('Found provider odds for combination', {
                    preMarketId,
                    optionKey,
                    preEventId,
                    preEventParticipantId,
                    providerOddsCount: allProviderOdds.length
                });

                if (allProviderOdds.length === 0) {
                    logger.info('No valid provider odds found for combination', {
                        preMarketId,
                        optionKey,
                        preEventId,
                        note: 'No odds match the criteria (status=AVAILABLE, within maxAgeSeconds)'
                    });

                    const existing = await PreOddsRepository.getPreOdds(
                        preMarketId,
                        optionKey,
                        transaction
                    );

                    if (existing) {
                        const preOddsRow = await PreOddsRepository.createOrUpdatePreOdds(
                            {
                                pre_event_id: preEventId,
                                pre_market_id: preMarketId,
                                option_key: optionKey,
                                pre_event_participant_id: preEventParticipantId,
                                average_odds: null,
                                provider_count: 0,
                                provider_odds: JSON.stringify({}),
                                display_odds: JSON.stringify({}),
                                display_odds_provider_ids: [],
                                outlier_odds_provider_ids: [],
                                active: false,
                                last_updated: new Date()
                            },
                            transaction
                        );
                        await this.publishPreOddsOutbox(
                            preOddsRow,
                            preEventId,
                            preMarketId,
                            optionKey,
                            transaction
                        );
                    }

                    return;
                }

                // Step 3: Convert to decimal odds & build map with timestamps
                // Store shape: { provider_id: { odds: {...}, sp: {...} | null } }
                const providerOddsMap: Record<number, any> = {};
                const providerOddsDecimal: Record<number, number> = {}; // For calculations

                for (const row of allProviderOdds) {
                    const providerId = row.provider_id;

                    // Skip if we already have odds from this provider (take latest)
                    if (providerOddsMap[providerId]) continue;

                    // Read decimal odds directly from odds field (now decimal(10,2))
                    // Note: PostgreSQL numeric(10,2) may be returned as string by Knex
                    let dec: number | null = null;
                    let fractional: string | null = null;

                    // Odds field is decimal(10,2) - handle both number and string from PostgreSQL
                    if (row.odds != null) {
                        const parsedOdds = typeof row.odds === 'number' ? row.odds : parseFloat(row.odds);
                        if (!isNaN(parsedOdds)) {
                            dec = parsedOdds;
                        }
                    }

                    // Fallback to display_odds if odds field is null (shouldn't happen, but for safety)
                    if (!dec && row.display_odds) {
                        try {
                            const displayOdds = typeof row.display_odds === 'string'
                                ? JSON.parse(row.display_odds)
                                : row.display_odds;

                            if (displayOdds.decimal) {
                                dec = Number(displayOdds.decimal);
                            } else if (displayOdds.dec) {
                                dec = Number(displayOdds.dec);
                            } else if (displayOdds.fractional) {
                                // Convert fractional to decimal if needed
                                dec = OddsCalculation.normalizeToDecimal(displayOdds.fractional);
                            }
                        } catch (e) {
                            // Invalid JSON, continue
                        }
                    }

                    // Validate and store fixed odds
                    if (dec && OddsCalculation.isValidOdds(dec) && isFinite(dec)) {
                        // Convert to fractional for display_odds JSON (still needed for presentation)
                        fractional = OddsCalculation.decimalToFractional(dec);

                        // Build nested structure with odds object
                        const oddsObject = {
                            decimal: dec,
                            fractional,
                            last_changed_at: row.last_changed_at || row.updated_at,
                            odds_status_id: row.odds_status_id || null
                        };

                        // Extract SP (Starting Price) from row.sp column if adapter supports it
                        // Note: PostgreSQL numeric(10,2) may be returned as string by Knex
                        let spObject: any = null;
                        if (getSportAdapter().hooks.odds.supportsStartingPrice()) {
                            if (row.sp != null) {
                                const spDecimal = typeof row.sp === 'number' ? row.sp : parseFloat(row.sp);
                                if (!isNaN(spDecimal) && OddsCalculation.isValidOdds(spDecimal) && isFinite(spDecimal)) {
                                    const spFractional = OddsCalculation.decimalToFractional(spDecimal);
                                    spObject = {
                                        decimal: spDecimal,
                                        fractional: spFractional,
                                        odds_status_id: getSportAdapter().oddsStatus.getStatus('STARTING_PRICE')
                                    };
                                }
                            }
                        }

                        // Store nested structure: { odds: {...}, sp: {...} | null }
                        providerOddsMap[providerId] = {
                            odds: oddsObject,
                            sp: spObject
                        };
                        providerOddsDecimal[providerId] = dec;
                    }
                }

                const oddsValues = Object.values(providerOddsDecimal);

                if (oddsValues.length === 0) {
                    logger.info('No valid odds found after filtering', {
                        preMarketId,
                        optionKey,
                        preEventId,
                        note: 'All odds were invalid or unavailable'
                    });

                    // Optional: Mark existing pre-odds as inactive if no valid odds
                    const existing = await PreOddsRepository.getPreOdds(
                        preMarketId,
                        optionKey,
                        transaction
                    );

                    if (existing) {
                        const preOddsRow = await PreOddsRepository.createOrUpdatePreOdds(
                            {
                                pre_event_id: preEventId,
                                pre_market_id: preMarketId,
                                option_key: optionKey,
                                pre_event_participant_id: preEventParticipantId,
                                average_odds: null,
                                provider_count: 0,
                                provider_odds: JSON.stringify({}),
                                display_odds: JSON.stringify({}),
                                display_odds_provider_ids: [],
                                outlier_odds_provider_ids: [],
                                active: false,
                                last_updated: new Date()
                            },
                            transaction
                        );
                        await this.publishPreOddsOutbox(
                            preOddsRow,
                            preEventId,
                            preMarketId,
                            optionKey,
                            transaction
                        );
                    }

                    return;
                }

                if (oddsValues.length < CONFIG.oddsCalculation.minProviders) {
                    logger.debug('Not enough valid odds for aggregation', {
                        preMarketId,
                        optionKey,
                        preEventId,
                        validOddsCount: oddsValues.length,
                        minProviders: CONFIG.oddsCalculation.minProviders
                    });
                    return;
                }

                // Step 4: Build candidates for outlier removal
                const candidates: ProviderOddsCandidate[] = Object.entries(providerOddsDecimal).map(
                    ([providerId, decimal]) => ({
                        providerId: Number(providerId),
                        decimal
                    })
                );

                // Step 4.1: Remove outliers using median-based detection
                const { included, outliers } = removeOutliers(
                    candidates,
                    ODDS_MARGIN_CONFIG.outlierTolerancePct
                );

                const includedProviderIds = included.map(c => c.providerId);
                const outlierProviderIds = outliers.map(c => c.providerId);
                const includedDecimals = included.map(c => c.decimal);

                // Step 4.2: Compute average from included providers only
                const avg = calculateMean(includedDecimals);

                if (avg === null) {
                    logger.warn('Failed to calculate average odds', {
                        preMarketId,
                        optionKey,
                        preEventId,
                        includedCount: included.length
                    });
                    return;
                }

                const activeProviderCount = included.length;

                // Step 4.3: Apply margin and snap to ladder
                // display_decimal_raw = average_odds / (1 + marginPct)
                const marginPct = ODDS_MARGIN_CONFIG.marginPct;
                const displayDecimalRaw = avg / (1 + marginPct);

                // Snap DOWN to the odds ladder
                const snapped = snapToLadder(displayDecimalRaw);

                // Step 4.4: Merge odds_status_id from providers
                const eventStartTime = await PreEventRepository.getEventStartTime(preEventId, transaction);

                const mergedOddsStatusId = this.mergeOddsStatusId(
                    providerOddsMap,
                    eventStartTime ?? undefined
                );

                // Step 5: Check if values changed (for history tracking)
                const existing = await PreOddsRepository.getPreOdds(
                    preMarketId,
                    optionKey,
                    transaction
                );

                // Compare provider_odds_json
                const existingProviderOdds = existing?.provider_odds
                    ? (typeof existing.provider_odds === 'string'
                        ? JSON.parse(existing.provider_odds)
                        : existing.provider_odds)
                    : {};

                const changed = !existing ||
                    existing.average_odds !== avg ||
                    existing.provider_count !== activeProviderCount ||
                    JSON.stringify(existingProviderOdds) !== JSON.stringify(providerOddsMap);

                if (!changed && existing) {
                    logger.debug('No changes detected, skipping update', {
                        preMarketId,
                        optionKey,
                        preEventId
                    });
                    return;
                }

                // Build display_odds JSONB (margin-adjusted, ladder-snapped)
                const displayOddsJson: any = {
                    decimal: snapped.decimal,
                    fractional: snapped.fractional,
                    as_of: new Date().toISOString()
                };

                // Include SP from any included provider if available
                if (getSportAdapter().hooks.odds.supportsStartingPrice()) {
                    for (const providerId of includedProviderIds) {
                        const providerData = providerOddsMap[providerId];
                        if (providerData?.sp) {
                            displayOddsJson.sp = {
                                decimal: providerData.sp.decimal,
                                fractional: providerData.sp.fractional
                            };
                            break; // Take first available SP
                        }
                    }
                }

                // Step 6: Upsert pre-odds
                const preOddsRow = await PreOddsRepository.createOrUpdatePreOdds(
                    {
                        pre_event_id: preEventId,
                        pre_market_id: preMarketId,
                        option_key: optionKey,
                        pre_event_participant_id: preEventParticipantId,
                        average_odds: avg,
                        provider_count: activeProviderCount,
                        provider_odds: JSON.stringify(providerOddsMap),
                        display_odds: JSON.stringify(displayOddsJson),
                        display_odds_provider_ids: includedProviderIds,
                        outlier_odds_provider_ids: outlierProviderIds,
                        active: true,
                        odds_status_id: mergedOddsStatusId,
                        last_updated: new Date()
                    },
                    transaction
                );

                await this.publishPreOddsOutbox(
                    preOddsRow,
                    preEventId,
                    preMarketId,
                    optionKey,
                    transaction
                );

                logger.info('Odds aggregated and saved for combination', {
                    preOddsId: preOddsRow?.id,
                    preMarketId,
                    optionKey,
                    preEventId,
                    preEventParticipantId,
                    averageOdds: avg.toFixed(4),
                    displayOdds: snapped.decimal,
                    marginPct,
                    providerCount: activeProviderCount,
                    includedProviderIds,
                    outlierProviderIds,
                    isNew: !existing,
                    changed
                });

            } catch (error) {
                logger.error('Error aggregating odds for combination', error as Error, {
                    preMarketId,
                    optionKey,
                    preEventId
                });
                throw error;
            }
        };

        if (trx) {
            return await execute(trx);
        } else {
            return await KnexClient.withRetryableTransaction(execute);
        }
    }

    /**
     * Merge odds_status_id from multiple providers
     * - If all providers agree, use that value
     * - If any provider has STARTING_PRICE (3), use that (highest priority)
     * - If providers disagree, calculate using last_changed_at vs start_time
     */
    private static mergeOddsStatusId(
        providerOddsMap: Record<number, any>,
        eventStartTime?: Date | string
    ): number {
        // Collect all odds_status_id values from providers (read from nested odds object)
        const statusIds: number[] = [];
        let mostRecentChangeTime: Date | null = null;

        for (const providerId of Object.keys(providerOddsMap).map(Number)) {
            const providerData = providerOddsMap[providerId];

            // Read from nested odds object
            const oddsObject = providerData?.odds;
            if (oddsObject?.odds_status_id != null) {
                statusIds.push(oddsObject.odds_status_id);
            }

            // Track most recent change time for calculation when providers disagree
            if (oddsObject?.last_changed_at) {
                const changeTime = oddsObject.last_changed_at instanceof Date
                    ? oddsObject.last_changed_at
                    : new Date(oddsObject.last_changed_at);

                if (!mostRecentChangeTime || changeTime > mostRecentChangeTime) {
                    mostRecentChangeTime = changeTime;
                }
            }
        }

        // If no status IDs found, return default (first valid status from adapter)
        if (statusIds.length === 0) {
            const defaultStatusId = Object.values(getSportAdapter().oddsStatus.statuses)[0] ?? 1;
            logger.debug('No odds_status_id found from providers, using default', { defaultStatusId });
            return defaultStatusId;
        }

        // Check if any provider has STARTING_PRICE (highest priority) — only for sports that support it
        if (getSportAdapter().hooks.odds.supportsStartingPrice()) {
            const startingPriceId = getSportAdapter().oddsStatus.getStatus('STARTING_PRICE');
            if (statusIds.includes(startingPriceId)) {
                logger.debug('Found STARTING_PRICE from providers, using it');
                return startingPriceId;
            }
        }

        // Check if all providers have the same value
        const uniqueStatusIds = [...new Set(statusIds)];
        if (uniqueStatusIds.length === 1 && uniqueStatusIds[0] != null) {
            // If event has started, override to STARTING_PRICE regardless of what providers report
            const eventHasStarted = eventStartTime ? new Date() > new Date(eventStartTime) : false;

            if (eventHasStarted && getSportAdapter().hooks.odds.supportsStartingPrice()) {
                logger.debug('Event has started, overriding to STARTING_PRICE', {
                    original_odds_status_id: uniqueStatusIds[0],
                    provider_count: statusIds.length
                });
                return getSportAdapter().oddsStatus.getStatus('STARTING_PRICE');
            }

            logger.debug('All providers agree on odds_status_id', {
                odds_status_id: uniqueStatusIds[0],
                provider_count: statusIds.length
            });
            return uniqueStatusIds[0];
        }

        // Providers disagree - calculate using last_changed_at vs start_time
        if (!eventStartTime) {
            logger.warn('Providers disagree on odds_status_id but start_time not available, using most common value', {
                statusIds,
                uniqueStatusIds
            });
            // Return the most common value
            const counts: Record<number, number> = {};
            statusIds.forEach(id => {
                counts[id] = (counts[id] || 0) + 1;
            });
            const mostCommon = Object.keys(counts).reduce((a, b) => {
                const countA = counts[Number(a)] ?? 0;
                const countB = counts[Number(b)] ?? 0;
                return countA > countB ? a : b;
            });
            return Number(mostCommon);
        }

        if (!mostRecentChangeTime) {
            logger.warn('Providers disagree on odds_status_id but last_changed_at not available, using most common value', {
                statusIds,
                uniqueStatusIds
            });
            // Return the most common value
            const counts: Record<number, number> = {};
            statusIds.forEach(id => {
                counts[id] = (counts[id] || 0) + 1;
            });
            const mostCommon = Object.keys(counts).reduce((a, b) => {
                const countA = counts[Number(a)] ?? 0;
                const countB = counts[Number(b)] ?? 0;
                return countA > countB ? a : b;
            });
            return Number(mostCommon);
        }

        // Calculate based on when the price changed
        const calculatedStatus = determineOddsStatusFromChangeTime(eventStartTime, mostRecentChangeTime);
        logger.debug('Providers disagree on odds_status_id, calculated from change time', {
            provider_status_ids: uniqueStatusIds,
            calculated_status_id: calculatedStatus,
            start_time: eventStartTime,
            most_recent_change_time: mostRecentChangeTime
        });
        return calculatedStatus;
    }

    /**
     * Re-aggregate all odds for an event (useful for UPDATE scenarios)
     */
    static async reAggregateEventOdds(
        preEventId: number,
        trx?: Knex.Transaction
    ): Promise<void> {
        const execute = async (transaction: any) => {
            try {
                // Get all pre-odds for this event
                const existingPreOdds = await PreOddsRepository.getPreOddsByEvent(preEventId, transaction);

                logger.info('Re-aggregating odds for event', {
                    preEventId,
                    combinationsCount: existingPreOdds.length
                });

                // Re-aggregate each combination
                for (const preOdd of existingPreOdds) {
                    await this.aggregateOddsForCombination(
                        preOdd.market_id,
                        preOdd.option_key,
                        preOdd.event_id,
                        preOdd.event_entry_id ?? null,
                        transaction
                    );
                }

                logger.info('Re-aggregation completed for event', {
                    preEventId,
                    combinationsCount: existingPreOdds.length
                });

            } catch (error) {
                logger.error('Error re-aggregating event odds', error as Error, {
                    preEventId
                });
                throw error;
            }
        };

        if (trx) {
            return await execute(trx);
        } else {
            return await KnexClient.withRetryableTransaction(execute);
        }
    }

    /**
     * Aggregate odds for a newly matched participant across all markets
     * Used to backfill missing pre-odds when participants are matched after odds arrive.
     */
    static async aggregateOddsForParticipant(
        preEventId: number,
        preEventParticipantId: number,
        trx?: Knex.Transaction
    ): Promise<void> {
        const execute = async (transaction: any) => {
            // Get all pre_markets for this event
            const preMarkets = await MarketRepository.getPreMarketsByEvent(
                preEventId,
                transaction
            );

            // Derive canonical option_key from participant ref_id
            const preParticipant = await PreEventParticipantRepository.getById(
                preEventParticipantId,
                transaction
            );
            const canonicalOptionKey = preParticipant?.ref_id || String(preEventParticipantId);

            for (const preMarket of preMarkets) {
                await this.aggregateOddsForCombination(
                    preMarket.id,
                    canonicalOptionKey,
                    preEventId,
                    preEventParticipantId,
                    transaction
                );
            }
        };

        if (trx) {
            return await execute(trx);
        }
        return await KnexClient.withRetryableTransaction(execute);
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
}
