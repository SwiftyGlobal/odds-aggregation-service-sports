/**
 * Pre Competition Repository
 * Canonical competitions live in event_groups (feed-sports-db).
 */

import { DatabaseService } from '../utils/database.js';
import { Knex } from 'knex';
import { TABLES } from '../constants/tables.js';
import { SPORT_IDS, SPORT_CODES } from '../constants/sports.js';
import { buildCompetitionRefId } from '../utils/refIdUtils.js';
import { getSportAdapter } from '../adapters/index.js';

export class PreCompetitionRepository {
    private static db = DatabaseService.getInstance();

    static async findCandidatesByDay(
        day: string,
        countryCode: string | null,
        requireCountryMatch: boolean,
        trx?: Knex.Transaction
    ): Promise<any[]> {
        const db = trx || this.db;

        const dayStart = new Date(`${day}T00:00:00.000Z`);
        const dayEnd = new Date(`${day}T23:59:59.999Z`);

        let query = db(TABLES.PRE_COMPETITIONS)
            .where('pre_sport_id', SPORT_IDS.CURRENT_SPORT)
            .whereBetween('start_time', [dayStart, dayEnd]);

        if (requireCountryMatch && countryCode) {
            query = query.where('country_code', countryCode);
        }

        return await query;
    }

    static async getPreCompetition(
        preCompetitionId: number,
        trx?: Knex.Transaction
    ): Promise<any | null> {
        const db = trx || this.db;
        return await db(TABLES.PRE_COMPETITIONS)
            .where('id', preCompetitionId)
            .first();
    }

    static async createOrUpdatePreCompetition(
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
        const matchField = adapter.matching.competition.matchField;
        const nameKey =
            matchField === 'venue_name' ? data.venue_name : data.competition_name;

        const refId = buildCompetitionRefId(
            SPORT_CODES.CURRENT_SPORT,
            data.day,
            data.country_code,
            nameKey
        );

        const startTime = new Date(`${data.day}T00:00:00.000Z`);
        const endTime = new Date(`${data.day}T23:59:59.999Z`);

        const [preCompetition] = await db(TABLES.PRE_COMPETITIONS)
            .insert({
                group_ref_id: refId,
                name: data.competition_name,
                pre_sport_id: SPORT_IDS.CURRENT_SPORT,
                group_type: 'tournament',
                country_code: data.country_code,
                start_time: startTime,
                end_time: endTime,
                metadata: { venue_name: data.venue_name },
                created_at: new Date(),
                updated_at: new Date()
            })
            .onConflict(adapter.matching.competition.conflictColumns)
            .merge({
                group_ref_id: refId,
                name: data.competition_name,
                start_time: startTime,
                end_time: endTime,
                metadata: { venue_name: data.venue_name },
                updated_at: new Date()
            })
            .returning('id');

        return preCompetition.id;
    }

    static async updatePreCompetition(
        preCompetitionId: number,
        updates: {
            venue_name?: string;
            country_code?: string;
            updated_at?: Date;
        },
        trx?: Knex.Transaction
    ): Promise<void> {
        const db = trx || this.db;

        const updateData: any = { ...updates };
        if (!updateData.updated_at) {
            updateData.updated_at = new Date();
        }

        await db(TABLES.PRE_COMPETITIONS)
            .where('id', preCompetitionId)
            .update(updateData);
    }
}
