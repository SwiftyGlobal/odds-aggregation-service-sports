/**
 * Market Type Repository
 * Database operations for market types
 */

import { DatabaseService } from '../utils/database.js';
import { Knex } from 'knex';
import { TABLES } from '../constants/tables.js';

export class MarketTypeRepository {
    private static db = DatabaseService.getInstance();

    /**
     * Get pre_market_type_id from provider market type ID
     */
    static async getPreMarketTypeId(
        providerMarketTypeId: number,
        trx?: Knex.Transaction
    ): Promise<number | null> {
        const db = trx || this.db;
        const result = await db(TABLES.PROVIDER_MARKET_TYPES)
            .where('id', providerMarketTypeId)
            .select('pre_market_template_id')
            .first();

        return result?.pre_market_template_id || null;
    }

    /**
     * Get pre_market_type_id by provider and market_ref_id
     * Falls back to first available market type for provider if exact match not found
     */
    static async getPreMarketTypeByRefId(
        providerId: number,
        marketRefId: number,
        trx?: Knex.Transaction
    ): Promise<number | null> {
        const db = trx || this.db;
        
        // Try exact match first
        let result = await db(TABLES.PROVIDER_MARKET_TYPES)
            .where({
                provider_id: providerId,
                market_type_ref_id: marketRefId
            })
            .select('pre_market_template_id')
            .first();

        if (result?.pre_market_template_id) {
            return result.pre_market_template_id;
        }

        // Fallback: Get first available market type for this provider
        // Since market types are pre-seeded and there's typically only one type (Winner)
        result = await db(TABLES.PROVIDER_MARKET_TYPES)
            .where('provider_id', providerId)
            .whereNotNull('pre_market_template_id')
            .select('pre_market_template_id')
            .first();

        return result?.pre_market_template_id || null;
    }

    /**
     * Get pre market type by ID
     */
    static async getPreMarketType(
        preMarketTypeId: number,
        trx?: Knex.Transaction
    ): Promise<any | null> {
        const db = trx || this.db;
        const row = await db(TABLES.PRE_MARKET_TYPES)
            .where('id', preMarketTypeId)
            .first();
        if (!row) return null;
        return {
            ...row,
            market_type_name: row.name,
            market_type_code: row.template_key,
        };
    }

    /**
     * Get all market types for a sport
     * 
     * @param sportId - The sport ID
     * @param trx - Optional transaction
     * @returns Array of market types
     */
    static async getBySportId(
        sportId: number,
        trx?: Knex.Transaction
    ): Promise<any[]> {
        const db = trx || this.db;
        return await db(TABLES.PRE_MARKET_TYPES)
            .where('active', true);
    }

    /**
     * Get provider market type by pre-market type and provider
     * 
     * @param preMarketTypeId - The pre-market type ID
     * @param providerId - The provider ID
     * @param trx - Optional transaction
     * @returns Provider market type or null
     */
    static async getProviderMarketTypeByPreMarketType(
        preMarketTypeId: number,
        providerId: number,
        trx?: Knex.Transaction
    ): Promise<any | null> {
        const db = trx || this.db;
        return await db(TABLES.PROVIDER_MARKET_TYPES)
            .where('pre_market_template_id', preMarketTypeId)
            .where('provider_id', providerId)
            .first();
    }
}

