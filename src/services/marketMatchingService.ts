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
import { MarketRepository } from '../repositories/marketRepository.js';
import { MarketTypeRepository } from '../repositories/marketTypeRepository.js';
import { EventRepository } from '../repositories/eventRepository.js';
import { EnsureService } from './ensureService.js';
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

            // Get pre_market_type_id from provider_market_type_id
            const preMarketTypeId = await MarketTypeRepository.getPreMarketTypeId(
                providerMarket.provider_market_type_id,
                transaction
            );

            if (!preMarketTypeId) {
                logger.warn('Market type not matched, skipping market matching', {
                    providerMarketId,
                    providerMarketTypeId: providerMarket.provider_market_type_id
                });
                return;
            }

            // Build canonical ref_id for this market
            const canonicalRefId = await this.buildCanonicalRefId(
                providerMarket,
                preEventId,
                preMarketTypeId,
                transaction
            );

            // Upsert pre_market
            const preMarket = await MarketRepository.upsertPreMarket(
                {
                    ref_id: canonicalRefId,
                    pre_event_id: preEventId,
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
     * Build canonical ref_id for a market
     *
     * For outrights: uses the pre_market_type code (e.g., "outright_winner")
     * For group markets (3-ball): uses sorted pre_event_participant_ids (e.g., "42:78:103")
     */
    private static async buildCanonicalRefId(
        providerMarket: any,
        preEventId: number,
        preMarketTypeId: number,
        transaction: Knex.Transaction
    ): Promise<string> {
        // Get the pre_market_type to determine the type
            const preMarketType = await MarketTypeRepository.getPreMarketType(preMarketTypeId, transaction);
            const marketTypeName =
                preMarketType?.market_type_name ||
                preMarketType?.name ||
                'unknown';
            const marketTypeCode =
                preMarketType?.market_type_code ||
                marketTypeName;

        // For outrights (Winner, Top 5, Top 10, Top 20), use market_type name as ref_id
        // This means there's one pre_market per market_type per event
        // For group markets, the ref_id would be built from participant IDs
        // For now, use the market_type name + any distinguishing metadata
        const metadata = typeof providerMarket.metadata === 'string'
            ? JSON.parse(providerMarket.metadata || '{}')
            : providerMarket.metadata || {};

        // If metadata has participant_ids (for group markets like 3-ball),
        // use sorted participant IDs as ref_id
        if (metadata.pre_event_participant_ids && Array.isArray(metadata.pre_event_participant_ids)) {
            const sorted = [...metadata.pre_event_participant_ids].sort((a: number, b: number) => a - b);
            return `${preEventId}:group:${sorted.join(':')}`;
        }

        // Default: use event-scoped market type key so ref_id stays globally unique.
        const normalizedType = String(marketTypeCode).toLowerCase().replace(/\s+/g, '_');
        return `${preEventId}:${normalizedType}`;
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

        const providerIds = [...new Set(providerMarkets.map((pm: any) => pm.provider_id))];

        await transaction(TABLES.PRE_MARKETS)
            .where('id', preMarketId)
            .update({
                linked_provider_ids: providerIds,
                updated_at: new Date()
            });
    }
}
