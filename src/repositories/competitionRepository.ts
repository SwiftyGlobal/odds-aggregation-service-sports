/**
 * Competition Repository
 * Database operations for provider competitions
 */

import { DatabaseService } from '../utils/database.js';
import { Knex } from 'knex';
import { TABLES } from '../constants/tables.js';

export class CompetitionRepository {
    private static db = DatabaseService.getInstance();
    private static normalizeRow(row: any): any {
        if (!row) return row;
        return {
            ...row,
            competition_ref_id: row.competition_ref_id ?? row.group_ref_id,
            competition_name: row.competition_name ?? row.name,
            pre_competition_id: row.pre_competition_id ?? row.pre_event_group_id,
            day: row.day ?? row.start_date,
        };
    }

    /**
     * Get provider competition by ID
     */
    static async getProviderCompetition(
        providerCompetitionId: number,
        trx?: Knex.Transaction
    ): Promise<any | null> {
        const db = trx || this.db;
        const row = await db(TABLES.PROVIDER_COMPETITIONS)
            .where('id', providerCompetitionId)
            .first();
        return this.normalizeRow(row);
    }

    /**
     * Update pre_competition_id for provider competition
     */
    static async updatePreCompetitionId(
        providerCompetitionId: number,
        preCompetitionId: number,
        trx?: Knex.Transaction
    ): Promise<void> {
        const db = trx || this.db;
        await db(TABLES.PROVIDER_COMPETITIONS)
            .where('id', providerCompetitionId)
            .update({
                pre_event_group_id: preCompetitionId,
                updated_at: new Date()
            });
    }
}

