/**
 * Provider event group repository — `fs_provider_event_groups` (and legacy competition-shaped rows).
 */

import { DatabaseService } from '../utils/database.js';
import { Knex } from 'knex';
import { TABLES } from '../constants/tables.js';

export class ProviderEventGroupRepository {
    private static db = DatabaseService.getInstance();

    private static parseMetadata(row: any): Record<string, unknown> {
        const raw = row?.metadata;
        if (raw == null) return {};
        if (typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
        if (typeof raw === 'string') {
            try {
                return JSON.parse(raw) as Record<string, unknown>;
            } catch {
                return {};
            }
        }
        return {};
    }

    private static normalizeRow(row: any): any {
        if (!row) return row;
        const dayFromStart =
            row.start_time != null
                ? new Date(row.start_time).toISOString().slice(0, 10)
                : null;
        const meta = this.parseMetadata(row);
        const venueFromMeta = meta.venue_name;
        return {
            ...row,
            competition_ref_id: row.competition_ref_id ?? row.group_ref_id,
            competition_name: row.competition_name ?? row.name,
            pre_competition_id: row.pre_competition_id ?? row.pre_event_group_id,
            pre_event_group_id: row.pre_event_group_id ?? row.pre_competition_id,
            venue_name: row.venue_name ?? venueFromMeta,
            day: row.day ?? dayFromStart ?? row.start_date,
        };
    }

    static async getProviderEventGroup(
        providerEventGroupId: number,
        trx?: Knex.Transaction
    ): Promise<any | null> {
        const db = trx || this.db;
        const row = await db(TABLES.PROVIDER_EVENT_GROUPS)
            .where('id', providerEventGroupId)
            .first();
        return this.normalizeRow(row);
    }

    static async updatePreEventGroupId(
        providerEventGroupId: number,
        preEventGroupId: number,
        trx?: Knex.Transaction
    ): Promise<void> {
        const db = trx || this.db;
        await db(TABLES.PROVIDER_EVENT_GROUPS)
            .where('id', providerEventGroupId)
            .update({
                pre_event_group_id: preEventGroupId,
                updated_at: new Date()
            });
    }
}
