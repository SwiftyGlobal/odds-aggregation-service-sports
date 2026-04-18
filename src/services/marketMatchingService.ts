/**
 * Market Matching Service
 * Matches provider markets to pre markets
 *
 * Strategy:
 * - For outrights (Winner, Top 5, etc.): canonical ref_id = market_type_code (e.g., "WIN", "TOP5")
 * - For group markets (3-ball): canonical ref_id = sorted pre_event_participant_ids (e.g., "42:78:103")
 * - Markets are matched within the same pre_event
 */

import { logger } from '../utils/logger.js';
import { metricsService } from './metricsService.js';
import { MarketRepository } from '../repositories/marketRepository.js';
import { MarketTypeRepository } from '../repositories/marketTypeRepository.js';
import { EventRepository } from '../repositories/eventRepository.js';
import { EnsureService } from './ensureService.js';
import { EventPeriodMatchingService } from './eventPeriodMatchingService.js';
import { DatabaseService } from '../utils/database.js';
import { DbConcurrencyManager } from '../utils/dbConcurrencyManager.js';
import { TABLES } from '../constants/tables.js';
import { Knex } from 'knex';

export class MarketMatchingService {
    /**
     * Process a market change (INSERT or UPDATE)
     */
    static async processMarketChange(
        providerMarketId: number,
        lsn: string
    ): Promise<void> {
        const operationId = `market-${providerMarketId}-${lsn}`;
        await DbConcurrencyManager.acquireDbSlot(operationId);

        try {
            await DatabaseService.withRetryableTransaction(async (transaction) => {
                await this.executeMarketChange(providerMarketId, lsn, transaction);
            });
        } finally {
            DbConcurrencyManager.releaseDbSlot(operationId);
        }
    }

    /**
     * Execute market change processing logic
     */
    private static async executeMarketChange(
        providerMarketId: number,
        lsn: string,
        transaction: Knex.Transaction
    ): Promise<void> {
        try {
            // Load provider market
            const providerMarket = await MarketRepository.getProviderMarket(providerMarketId, transaction);

            if (!providerMarket) {
                logger.warn('Provider market not found', { providerMarketId });
                return;
            }

            logger.info('Processing market change', {
                providerMarketId,
                providerEventId: providerMarket.provider_event_id,
                marketRefId: providerMarket.market_ref_id,
                providerId: providerMarket.provider_id,
                lsn
            });

            // Ensure parent event is matched
            const preEventId = await EnsureService.ensurePreEventFromProvider(
                providerMarket.provider_event_id,
                transaction
            );

            if (!preEventId) {
                logger.info('Parent event not matched yet, skipping market matching', {
                    providerMarketId,
                    providerEventId: providerMarket.provider_event_id
                });
                return;
            }

            const preMarketTypeId = providerMarket.ref_market_template_id;

            if (!preMarketTypeId) {
                logger.error('Market missing ref_market_template_id; cannot match to canonical template', {
                    providerMarketId,
                    providerId: providerMarket.provider_id,
                    providerEventId: providerMarket.provider_event_id,
                    marketRefId: providerMarket.market_ref_id,
                });
                metricsService.increment('market_matching_missing_ref_template_total', {
                    provider_id: providerMarket.provider_id,
                });
                return;
            }

            // Resolve canonical period for period-scoped markets (e.g. golf rounds).
            // Provider may have written `provider_event_period_id` only when the
            // market is period-scoped — so a null here just means "event-wide".
            let preEventPeriodId: number | null = null;
            if (providerMarket.provider_event_period_id) {
                preEventPeriodId = await EventPeriodMatchingService.ensurePreEventPeriod(
                    providerMarket.provider_event_period_id,
                    transaction
                );
            }

            // Build canonical ref_id for this market.
            // Period-scoped markets (e.g. round 1 vs round 2 three-ball) must
            // not collide on (template, sorted_entry_ids) — fold the period in.
            const canonicalRefId = await this.buildCanonicalRefId(
                providerMarket,
                preEventId,
                preMarketTypeId,
                preEventPeriodId,
                transaction
            );

            // Upsert pre_market
            const preMarket = await MarketRepository.upsertPreMarket(
                {
                    ref_id: canonicalRefId,
                    pre_event_id: preEventId,
                    pre_event_period_id: preEventPeriodId,
                    pre_market_type_id: preMarketTypeId,
                    name: providerMarket.name,
                    display_name: providerMarket.display_name,
                    start_time: providerMarket.start_time,
                    end_time: providerMarket.end_time,
                    status: providerMarket.status || 'open',
                    metadata: typeof providerMarket.metadata === 'string'
                        ? JSON.parse(providerMarket.metadata)
                        : providerMarket.metadata || {},
                    linked_provider_ids: [providerMarket.provider_id]
                },
                transaction
            );

            // Link provider market to pre market (or re-link if canonical ref changed)
            if (providerMarket.pre_market_id !== preMarket.id) {
                await MarketRepository.linkProviderMarket(
                    providerMarketId,
                    preMarket.id,
                    transaction
                );
            }

            // Update linked_provider_ids on pre_market to include this provider
            await this.updateLinkedProviders(preMarket.id, transaction);

            logger.info('Market matched successfully', {
                providerMarketId,
                preMarketId: preMarket.id,
                canonicalRefId,
                preEventId,
                lsn
            });

        } catch (error) {
            logger.error('Error processing market change', error as Error, {
                providerMarketId,
                lsn
            });
            throw error;
        }
    }

    /**
     * Build canonical ref_id for a market.
     *
     * Identity composition:
     *   `<preEventId>[:p<preEventPeriodId>]:(<template>|group:<sortedEntryIds>)`
     *
     * - Period segment is included only when the market is period-scoped
     *   (`preEventPeriodId != null`). Event-wide markets stay on the legacy
     *   `<preEventId>:<template>` key for backwards compatibility.
     * - Group markets (e.g. 3-ball) use the sorted pre_event_participant_ids
     *   passed in via `metadata.pre_event_participant_ids`. The same trio in
     *   round 1 vs round 2 must produce two distinct pre_markets — that is
     *   what the period segment guarantees.
     */
    private static async buildCanonicalRefId(
        providerMarket: any,
        preEventId: number,
        preMarketTypeId: number,
        preEventPeriodId: number | null,
        transaction: Knex.Transaction
    ): Promise<string> {
        const preMarketType = await MarketTypeRepository.getPreMarketType(preMarketTypeId, transaction);
        const marketTypeName =
            preMarketType?.market_type_name ||
            preMarketType?.name ||
            'unknown';
        const marketTypeCode =
            preMarketType?.market_type_code ||
            marketTypeName;

        const metadata = typeof providerMarket.metadata === 'string'
            ? JSON.parse(providerMarket.metadata || '{}')
            : providerMarket.metadata || {};

        const periodSegment = preEventPeriodId != null ? `:p${preEventPeriodId}` : '';

        if (metadata.pre_event_participant_ids && Array.isArray(metadata.pre_event_participant_ids)) {
            const sorted = [...metadata.pre_event_participant_ids].sort((a: number, b: number) => a - b);
            return `${preEventId}${periodSegment}:group:${sorted.join(':')}`;
        }

        const normalizedType = String(marketTypeCode).toLowerCase().replace(/\s+/g, '_');
        return `${preEventId}${periodSegment}:${normalizedType}`;
    }

    /**
     * Update pre_market fields from a provider market (for already-matched markets)
     */
    private static async updatePreMarketFromProvider(
        providerMarket: any,
        transaction: Knex.Transaction
    ): Promise<void> {
        if (!providerMarket.pre_market_id) return;

        const preMarket = await MarketRepository.getPreMarket(providerMarket.pre_market_id, transaction);
        if (!preMarket) return;

        // Update time fields if provider has more specific info
        const updates: Record<string, any> = {};

        if (providerMarket.start_time && !preMarket.start_time) {
            updates.start_time = providerMarket.start_time;
        }
        if (providerMarket.end_time && !preMarket.end_time) {
            updates.end_time = providerMarket.end_time;
        }
        if (providerMarket.status && providerMarket.status !== preMarket.status) {
            updates.status = providerMarket.status;
        }

        if (Object.keys(updates).length > 0) {
            updates.updated_at = new Date();
            updates.last_changed_at = new Date();

            const db = transaction;
            await db(TABLES.PRE_MARKETS)
                .where('id', providerMarket.pre_market_id)
                .update(updates);

            logger.debug('Pre-market updated from provider', {
                preMarketId: providerMarket.pre_market_id,
                updates: Object.keys(updates)
            });
        }
    }

    /**
     * Update linked_provider_ids on a pre_market by scanning all linked provider_markets
     */
    private static async updateLinkedProviders(
        preMarketId: number,
        transaction: Knex.Transaction
    ): Promise<void> {
        const providerMarkets = await MarketRepository.getProviderMarketsByPreMarket(
            preMarketId,
            transaction
        );

        const providerIds = Array.from(
            new Set<number>(providerMarkets.map((pm: any) => Number(pm.provider_id)))
        ).sort((a, b) => a - b);

        await transaction(TABLES.PRE_MARKETS)
            .where('id', preMarketId)
            .update({
                linked_provider_ids: providerIds,
                linked_provider_count: providerIds.length,
                updated_at: new Date()
            });
    }
}
