/**
 * Market Repository
 * Database operations for provider_markets and pre_markets
 */

import { KnexClient } from '../config/knex.js';
import { Knex } from 'knex';
import { TABLES } from '../constants/tables.js';

export class MarketRepository {
    private static db = KnexClient.getInstance();

    /**
     * Get provider market by ID
     */
    static async getProviderMarket(
        providerMarketId: number,
        trx?: Knex.Transaction
    ): Promise<any | null> {
        const db = trx || this.db;
        const row = await db(TABLES.PROVIDER_MARKETS)
            .where('id', providerMarketId)
            .first();
        if (!row) return null;
        return {
            ...row,
            status: row.status ?? row.market_status,
        };
    }

    /**
     * Get pre_market_id from provider market ID
     */
    static async getPreMarketId(
        providerMarketId: number,
        trx?: Knex.Transaction
    ): Promise<number | null> {
        const db = trx || this.db;
        const result = await db(TABLES.PROVIDER_MARKETS)
            .where('id', providerMarketId)
            .select('pre_market_id')
            .first();

        return result?.pre_market_id || null;
    }

    /**
     * Get pre market by ID
     */
    static async getPreMarket(
        preMarketId: number,
        trx?: Knex.Transaction
    ): Promise<any | null> {
        const db = trx || this.db;
        const row = await db(TABLES.PRE_MARKETS)
            .where('id', preMarketId)
            .first();
        if (!row) return null;
        return {
            ...row,
            status: row.status ?? row.market_status,
            event_id: row.event_id ?? row.pre_event_id,
            template_id: row.template_id ?? row.ref_market_template_id,
        };
    }

    /**
     * Get all pre_markets for a pre-event
     */
    static async getPreMarketsByEvent(
        preEventId: number,
        trx?: Knex.Transaction
    ): Promise<any[]> {
        const db = trx || this.db;
        return await db(TABLES.PRE_MARKETS)
            .where('pre_event_id', preEventId);
    }

    /**
     * Get all provider_markets that link to a pre_market
     */
    static async getProviderMarketsByPreMarket(
        preMarketId: number,
        trx?: Knex.Transaction
    ): Promise<any[]> {
        const db = trx || this.db;
        return await db(TABLES.PROVIDER_MARKETS)
            .where('pre_market_id', preMarketId);
    }

    /**
     * Get provider markets for a provider event
     */
    static async getProviderMarketsByEvent(
        providerEventId: number,
        trx?: Knex.Transaction
    ): Promise<any[]> {
        const db = trx || this.db;
        return await db(TABLES.PROVIDER_MARKETS)
            .where('provider_event_id', providerEventId);
    }

    /**
     * Upsert a provider market
     */
    static async upsertProviderMarket(
        data: {
            market_ref_id: string;
            provider_event_id: number;
            provider_market_type_id: number;
            name?: string | null;
            display_name?: string | null;
            start_time?: Date | null;
            end_time?: Date | null;
            status?: string;
            is_suspended?: boolean;
            metadata?: Record<string, any>;
            provider_id: number;
            pre_market_id?: number | null;
        },
        trx?: Knex.Transaction
    ): Promise<any> {
        const db = trx || this.db;

        const [result] = await db(TABLES.PROVIDER_MARKETS)
            .insert({
                market_ref_id: data.market_ref_id,
                provider_event_id: data.provider_event_id,
                provider_market_type_id: data.provider_market_type_id,
                name: data.name || null,
                display_name: data.display_name || null,
                start_time: data.start_time || null,
                end_time: data.end_time || null,
                market_status: data.status || 'open',
                is_suspended: data.is_suspended || false,
                metadata: data.metadata || {},
                provider_id: data.provider_id,
                pre_market_id: data.pre_market_id || null,
                created_at: new Date(),
                updated_at: new Date()
            })
            .onConflict(['provider_id', 'market_ref_id'])
            .merge({
                provider_event_id: data.provider_event_id,
                provider_market_type_id: data.provider_market_type_id,
                name: data.name || null,
                display_name: data.display_name || null,
                start_time: data.start_time || null,
                end_time: data.end_time || null,
                market_status: data.status || 'open',
                is_suspended: data.is_suspended || false,
                metadata: data.metadata || {},
                pre_market_id: data.pre_market_id || null,
                updated_at: new Date()
            })
            .returning('*');

        return result;
    }

    /**
     * Upsert a pre market
     */
    static async upsertPreMarket(
        data: {
            ref_id: string;
            pre_event_id: number;
            pre_market_type_id: number;
            name?: string | null;
            display_name?: string | null;
            start_time?: Date | null;
            end_time?: Date | null;
            status?: string;
            metadata?: Record<string, any>;
            linked_provider_ids?: number[];
        },
        trx?: Knex.Transaction
    ): Promise<any> {
        const db = trx || this.db;

        const [result] = await db(TABLES.PRE_MARKETS)
            .insert({
                market_ref_id: data.ref_id,
                pre_event_id: data.pre_event_id,
                ref_market_template_id: data.pre_market_type_id,
                name: data.name || null,
                display_name: data.display_name || null,
                start_time: data.start_time || null,
                end_time: data.end_time || null,
                market_status: data.status || 'open',
                metadata: data.metadata || {},
                linked_provider_ids: data.linked_provider_ids || [],
                last_changed_at: new Date(),
                created_at: new Date(),
                updated_at: new Date()
            })
            .onConflict(['pre_event_id', 'market_ref_id'])
            .merge({
                name: data.name || null,
                display_name: data.display_name || null,
                start_time: data.start_time || null,
                end_time: data.end_time || null,
                market_status: data.status || 'open',
                metadata: data.metadata || {},
                linked_provider_ids: data.linked_provider_ids || [],
                last_changed_at: new Date(),
                updated_at: new Date()
            })
            .returning('*');

        return result;
    }

    /**
     * Link a provider market to a pre market
     */
    static async linkProviderMarket(
        providerMarketId: number,
        preMarketId: number,
        trx?: Knex.Transaction
    ): Promise<void> {
        const db = trx || this.db;
        await db(TABLES.PROVIDER_MARKETS)
            .where('id', providerMarketId)
            .update({
                pre_market_id: preMarketId,
                updated_at: new Date()
            });
    }
}
