/**
 * Pre event group repository — canonical groups in `fs_pre_event_groups`.
 */

import { DatabaseService } from '../utils/database.js';
import { Knex } from 'knex';
import { TABLES } from '../constants/tables.js';
import { SPORT_IDS, SPORT_CODES } from '../constants/sports.js';
import { buildEventGroupRefId } from '../utils/refIdUtils.js';
import { getSportAdapter } from '../adapters/index.js';

function parseMetadata(row: any): Record<string, unknown> {
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

export class PreEventGroupRepository {
    private static db = DatabaseService.getInstance();

    private static normalizeRow(row: any): any {
        if (!row) return row;
        const meta = parseMetadata(row);
        return {
            ...row,
            venue_name: (row as { venue_name?: string }).venue_name ?? meta.venue_name,
        };
    }

    static async findCandidatesByDay(
        day: string,
        countryCode: string | null,
        requireCountryMatch: boolean,
        trx?: Knex.Transaction
    ): Promise<any[]> {
        const db = trx || this.db;

        const dayStart = new Date(`${day}T00:00:00.000Z`);
        const dayEnd = new Date(`${day}T23:59:59.999Z`);

        let query = db(TABLES.PRE_EVENT_GROUPS)
            .where('pre_sport_id', SPORT_IDS.CURRENT_SPORT)
            .whereBetween('start_time', [dayStart, dayEnd]);

        if (requireCountryMatch && countryCode) {
            query = query.where('country_code', countryCode);
        }

        const rows = await query;
        return rows.map((r) => this.normalizeRow(r));
    }

    static async findCandidatesForCurrentSport(
        countryCode: string | null,
        requireCountryMatch: boolean,
        trx?: Knex.Transaction
    ): Promise<any[]> {
        const db = trx || this.db;

        let query = db(TABLES.PRE_EVENT_GROUPS).where('pre_sport_id', SPORT_IDS.CURRENT_SPORT);

        if (requireCountryMatch && countryCode) {
            query = query.where('country_code', countryCode);
        }

        const rows = await query;
        return rows.map((r) => this.normalizeRow(r));
    }

    static async getPreEventGroup(preEventGroupId: number, trx?: Knex.Transaction): Promise<any | null> {
        const db = trx || this.db;
        const row = await db(TABLES.PRE_EVENT_GROUPS).where('id', preEventGroupId).first();
        return this.normalizeRow(row);
    }

    static async createOrUpdatePreEventGroup(
        data: {
            competition_name: string;
            venue_name: string;
            country_code: string | null;
            day: string;
        },
        trx?: Knex.Transaction
    ): Promise<number> {
        const db = trx || this.db;

        const adapter = getSportAdapter();
        const matchField = adapter.matching.eventGroup.matchField;
        const nameKey =
            matchField === 'venue_name' ? data.venue_name : data.competition_name;

        const refId = buildEventGroupRefId(
            SPORT_CODES.CURRENT_SPORT,
            data.day,
            data.country_code,
            nameKey
        );

        const startTime = new Date(`${data.day}T00:00:00.000Z`);
        const endTime = new Date(`${data.day}T23:59:59.999Z`);

        const metadata = { venue_name: data.venue_name };

        const [preEventGroup] = await db(TABLES.PRE_EVENT_GROUPS)
            .insert({
                group_ref_id: refId,
                name: data.competition_name,
                pre_sport_id: SPORT_IDS.CURRENT_SPORT,
                group_type: 'tournament',
                country_code: data.country_code,
                start_time: startTime,
                end_time: endTime,
                metadata,
                created_at: new Date(),
                updated_at: new Date()
            })
            .onConflict(adapter.matching.eventGroup.conflictColumns)
            .merge({
                group_ref_id: refId,
                name: data.competition_name,
                start_time: startTime,
                end_time: endTime,
                metadata,
                updated_at: new Date()
            })
            .returning('id');

        return preEventGroup.id;
    }

    static async updatePreEventGroup(
        preEventGroupId: number,
        updates: {
            venue_name?: string;
            country_code?: string;
            updated_at?: Date;
        },
        trx?: Knex.Transaction
    ): Promise<void> {
        const db = trx || this.db;

        const updatedAt = updates.updated_at ?? new Date();
        const payload: Record<string, unknown> = { updated_at: updatedAt };

        if (updates.country_code !== undefined) {
            payload.country_code = updates.country_code;
        }

        if (updates.venue_name !== undefined) {
            await db(TABLES.PRE_EVENT_GROUPS)
                .where('id', preEventGroupId)
                .update({
                    ...payload,
                    metadata: db.raw(
                        `coalesce(metadata, '{}'::jsonb) || ?::jsonb`,
                        [JSON.stringify({ venue_name: updates.venue_name })]
                    )
                });
            return;
        }

        if (Object.keys(payload).length > 0) {
            await db(TABLES.PRE_EVENT_GROUPS).where('id', preEventGroupId).update(payload);
        }
    }
}
