/**
 * Market Type Repository
 * Reads canonical templates from fs_ref_market_templates (PRE_MARKET_TYPES adapter mapping).
 */

import { DatabaseService } from '../utils/database.js';
import { Knex } from 'knex';
import { TABLES } from '../constants/tables.js';

export class MarketTypeRepository {
    private static db = DatabaseService.getInstance();

    /**
     * Get ref market template row by id
     */
    static async getPreMarketType(
        preMarketTemplateId: number,
        trx?: Knex.Transaction
    ): Promise<any | null> {
        const db = trx || this.db;
        const row = await db(TABLES.PRE_MARKET_TYPES)
            .where('id', preMarketTemplateId)
            .first();
        if (!row) return null;
        return {
            ...row,
            market_type_name: row.name,
            market_type_code: row.template_key,
        };
    }

    /**
     * Active ref templates (sport-wide list; ref layer is not partitioned by pre_sport_id)
     */
    static async getBySportId(
        _sportId: number,
        trx?: Knex.Transaction
    ): Promise<any[]> {
        void _sportId;
        const db = trx || this.db;
        return await db(TABLES.PRE_MARKET_TYPES).where('active', true);
    }
}
