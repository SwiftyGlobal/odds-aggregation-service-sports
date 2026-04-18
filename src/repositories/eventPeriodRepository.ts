/**
 * Event Period Repository
 * Database operations for provider/pre event periods.
 */

import { DatabaseService } from '../utils/database.js';
import { Knex } from 'knex';
import { TABLES } from '../constants/tables.js';

export class EventPeriodRepository {
    private static db = DatabaseService.getInstance();

    /**
     * Get provider event period by id.
     */
    static async getProviderEventPeriod(
        providerEventPeriodId: number,
        trx?: Knex.Transaction
    ): Promise<any | null> {
        const db = trx || this.db;
        const table = TABLES.PROVIDER_EVENT_PERIODS;
        if (!table) return null;
        return await db(table).where('id', providerEventPeriodId).first() || null;
    }

    /**
     * Update pre_event_period_id back-reference on provider row.
     */
    static async updatePreEventPeriodId(
        providerEventPeriodId: number,
        preEventPeriodId: number,
        trx?: Knex.Transaction
    ): Promise<void> {
        const db = trx || this.db;
        const table = TABLES.PROVIDER_EVENT_PERIODS;
        if (!table) return;
        await db(table)
            .where('id', providerEventPeriodId)
            .update({
                pre_event_period_id: preEventPeriodId,
                updated_at: new Date(),
            });
    }

    /**
     * Find-or-create a canonical period row for (pre_event_id, period_type, period_number).
     * Idempotent via the unique index (pre_event_id, parent_period_id, period_type, period_number).
     */
    static async findOrCreatePreEventPeriod(
        preEventId: number,
        periodType: string,
        periodNumber: number,
        trx?: Knex.Transaction
    ): Promise<number> {
        const db = trx || this.db;
        const table = TABLES.PRE_EVENT_PERIODS;
        if (!table) throw new Error('PRE_EVENT_PERIODS table not configured for this sport');

        const existing = await db(table)
            .where({
                pre_event_id: preEventId,
                period_type: periodType,
                period_number: periodNumber,
            })
            .whereNull('parent_period_id')
            .first();
        if (existing) return existing.id as number;

        const periodRefId = `${preEventId}:${periodType}:${periodNumber}`;
        const now = new Date();
        const [row] = await db(table)
            .insert({
                pre_event_id: preEventId,
                period_ref_id: periodRefId,
                period_type: periodType,
                period_number: periodNumber,
                status: 'scheduled',
                period_data: {},
                created_at: now,
                updated_at: now,
            })
            .onConflict(['pre_event_id', 'parent_period_id', 'period_type', 'period_number'])
            .merge({ updated_at: now })
            .returning('id');

        return row.id as number;
    }
}
