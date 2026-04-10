/**
 * Event Repository
 * Database operations for provider events
 */

import { DatabaseService } from '../utils/database.js';
import { Knex } from 'knex';
import { TABLES } from '../constants/tables.js';

export class EventRepository {
    private static db = DatabaseService.getInstance();
    private static statusToLegacyId(status?: string | null): number {
        if (status === 'completed') return 3;
        if (status === 'in_progress') return 2;
        return 1;
    }
    private static normalizeRow(row: any): any {
        if (!row) return row;
        return {
            ...row,
            provider_competition_id: row.provider_competition_id ?? row.provider_event_group_id,
            event_status_id: row.event_status_id ?? this.statusToLegacyId(row.event_status),
        };
    }

    /**
     * Get provider event by ID
     */
    static async getProviderEvent(
        providerEventId: number,
        trx?: Knex.Transaction
    ): Promise<any | null> {
        const db = trx || this.db;
        const row = await db(TABLES.PROVIDER_EVENTS)
            .where('id', providerEventId)
            .first();
        return this.normalizeRow(row);
    }

    /**
     * Update pre_event_id for provider event
     */
    static async updatePreEventId(
        providerEventId: number,
        preEventId: number,
        trx?: Knex.Transaction
    ): Promise<void> {
        const db = trx || this.db;
        await db(TABLES.PROVIDER_EVENTS)
            .where('id', providerEventId)
            .update({
                pre_event_id: preEventId,
                updated_at: new Date()
            });
    }

    /**
     * Get all provider events for a pre-event
     */
    static async getProviderEventsByPreEventId(
        preEventId: number,
        trx?: Knex.Transaction
    ): Promise<any[]> {
        const db = trx || this.db;
        const rows = await db(TABLES.PROVIDER_EVENTS)
            .where('pre_event_id', preEventId)
            .select('*');
        return rows.map((row: any) => this.normalizeRow(row));
    }

    /**
     * Get eligible provider events for a pre-event filtered by provider IDs
     * Used for status promotion - only includes events from eligible providers
     */
    static async getEligibleProviderEventsByPreEventId(
        preEventId: number,
        eligibleProviderIds: number[],
        trx?: Knex.Transaction
    ): Promise<any[]> {
        const db = trx || this.db;
        const rows = await db(TABLES.PROVIDER_EVENTS)
            .where('pre_event_id', preEventId)
            .whereIn('provider_id', eligibleProviderIds)
            .select('*');
        return rows.map((row: any) => this.normalizeRow(row));
    }

    /**
     * Get provider event by provider ID and event ref ID
     * 
     * @param providerId - The provider ID
     * @param eventRefId - The event reference ID
     * @param trx - Optional transaction
     * @returns Provider event or null
     */
    static async getByProviderAndRefId(
        providerId: number,
        eventRefId: string,
        trx?: Knex.Transaction
    ): Promise<any | null> {
        const db = trx || this.db;
        const row = await db(TABLES.PROVIDER_EVENTS)
            .where({
                provider_id: providerId,
                event_ref_id: eventRefId
            })
            .first();
        return this.normalizeRow(row);
    }
}

