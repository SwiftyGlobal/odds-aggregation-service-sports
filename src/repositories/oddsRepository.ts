/**
 * Odds Repository
 * Database operations for provider odds
 */

import { KnexClient } from '../config/knex.js';
import { Knex } from 'knex';
import { getSportAdapter } from '../adapters/index.js';
import { TABLES } from '../constants/tables.js';

export class OddsRepository {
    private static db = KnexClient.getInstance();
    private static statusToLegacyId(status?: string | null): number {
        return status === 'suspended' ? 2 : 1;
    }

    /**
     * Get provider odds by ID with joins to event/participant/market
     */
    static async getProviderOdds(
        providerOddsId: number,
        trx?: Knex.Transaction
    ): Promise<any | null> {
        const db = trx || this.db;
        const row = await db(TABLES.PROVIDER_ODDS)
            .where(`${TABLES.PROVIDER_ODDS}.id`, providerOddsId)
            .first();
        if (!row) return null;
        return {
            ...row,
            provider_event_participant_id: row.provider_event_entry_id,
            odds: row.price,
            odds_status_id: this.statusToLegacyId(row.selection_status),
        };
    }

    /**
     * Get provider odds by market and option key
     */
    static async getProviderOddsByMarketAndOptionKey(
        providerMarketId: number,
        optionKey: string,
        trx?: Knex.Transaction
    ): Promise<any | null> {
        const db = trx || this.db;
        const row = await db(TABLES.PROVIDER_ODDS)
            .where({
                provider_market_id: providerMarketId,
                option_key: optionKey
            })
            .first();
        if (!row) return null;
        return {
            ...row,
            provider_event_participant_id: row.provider_event_entry_id,
            odds: row.price,
            odds_status_id: this.statusToLegacyId(row.selection_status),
        };
    }

    /**
     * Get all provider odds for a pre-market combination
     * Returns odds from all providers for the same pre-market and selection
     *
     * Strategy:
     * 1. Find all provider_markets that map to this pre_market_id
     * 2. For participant-based: find provider_event_participants matching pre_event_participant_id
     * 3. For non-participant (draw): match by null provider_event_participant_id
     * 4. Load all provider odds matching those criteria
     */
    static async getAllProviderOddsForPreMarket(
        preMarketId: number,
        preEventParticipantId: number | null,
        maxAgeSeconds: number,
        trx?: Knex.Transaction
    ): Promise<any[]> {
        const db = trx || this.db;
        const cutoffTime = new Date(Date.now() - maxAgeSeconds * 1000);

        // Step 1: Find all provider_markets that map to this pre_market_id
        const providerMarkets = await db(TABLES.PROVIDER_MARKETS)
            .where('pre_market_id', preMarketId)
            .select('id', 'provider_id');

        if (providerMarkets.length === 0) {
            return [];
        }

        const providerMarketIds = providerMarkets.map(m => m.id);

        // Step 2: Build query based on selection type
        let query = db(`${TABLES.PROVIDER_ODDS} as po`)
            .join(`${TABLES.PROVIDER_MARKETS} as pm`, 'po.provider_market_id', 'pm.id')
            .whereIn('po.provider_market_id', providerMarketIds)
            .whereIn('po.selection_status', ['active', 'suspended'])
            .where('po.updated_at', '>', cutoffTime)
            .orderBy('po.updated_at', 'desc')
            .select(
                'po.*',
                'pm.provider_id',
                'po.provider_event_entry_id as provider_event_participant_id',
                'po.price as odds',
                db.raw('CASE WHEN po.selection_status = ? THEN 2 ELSE 1 END as odds_status_id', ['suspended'])
            );

        if (preEventParticipantId != null) {
            // Participant-based selection: match via participant chain across providers
            const providerEventParticipants = await db(TABLES.PROVIDER_EVENT_PARTICIPANTS)
                .where('pre_event_entry_id', preEventParticipantId)
                .select('id');

            if (providerEventParticipants.length === 0) {
                return [];
            }

            const pepIds = providerEventParticipants.map((p: any) => p.id);
            query = query.whereRaw('po.provider_event_entry_id = ANY(?)', [pepIds]);
        } else {
            // Non-participant selection (e.g., Draw): match odds with no participant
            query = query.whereNull('po.provider_event_entry_id');
        }

        return await query;
    }

    /**
     * Get provider odds by market and participant with cutoff time
     *
     * @param providerMarketId - The provider market ID (FK to provider_markets)
     * @param providerEventParticipantId - The provider event participant ID (nullable)
     * @param cutoffTime - The cutoff time (only odds created after this time)
     * @param trx - Optional transaction
     * @returns Array of provider odds ordered by created_at desc
     */
    static async getByMarketAndParticipantWithCutoff(
        providerMarketId: number,
        providerEventParticipantId: number | null,
        cutoffTime: Date,
        trx?: Knex.Transaction
    ): Promise<any[]> {
        const db = trx || this.db;
        let query = db(TABLES.PROVIDER_ODDS)
            .where('provider_market_id', providerMarketId)
            .where('created_at', '>', cutoffTime)
            .orderBy('created_at', 'desc');

        if (providerEventParticipantId != null) {
            query = query.where('provider_event_entry_id', providerEventParticipantId);
        } else {
            query = query.whereNull('provider_event_entry_id');
        }

        return await query;
    }
}

