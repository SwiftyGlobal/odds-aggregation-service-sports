/**
 * Pre Event Participant Repository
 * Database operations for canonical event entries (fs_pre_event_entries) and participants (fs_pre_participants)
 */

import { KnexClient } from '../config/knex.js';
import { Knex } from 'knex';
import { TABLES } from '../constants/tables.js';
import { PreEventParticipantHistoryRepository } from './preEventParticipantHistoryRepository.js';
import { logger } from '../utils/logger.js';
import { getSportAdapter } from '../adapters/index.js';

function parseMetadata(raw: any): Record<string, any> | null {
    if (!raw) return null;
    if (typeof raw === 'object') return raw;
    try { return JSON.parse(raw); } catch { return null; }
}

function normalize(val: string | null | undefined): string | null {
    if (!val) return null;
    const trimmed = val.trim().toLowerCase();
    return trimmed || null;
}

export class PreEventParticipantRepository {
    private static db = KnexClient.getInstance();

    static readonly SHORT_NAME_MAX_LEN = 100;

    static truncateShortName(s: string): string {
        return s.length <= this.SHORT_NAME_MAX_LEN ? s : s.slice(0, this.SHORT_NAME_MAX_LEN);
    }

    /**
     * Find or create fs_pre_participants row keyed by (pre_sport_id, short_name).
     */
    static async ensurePreParticipant(
        preSportId: number,
        shortNameRaw: string,
        name: string,
        trx?: Knex.Transaction
    ): Promise<number> {
        const db = trx || this.db;
        const short_name = this.truncateShortName(shortNameRaw);
        const row = await db(TABLES.PRE_PARTICIPANTS)
            .where({ pre_sport_id: preSportId, short_name })
            .first();

        if (row) {
            if (name && String(row.name) !== name) {
                await db(TABLES.PRE_PARTICIPANTS)
                    .where('id', row.id)
                    .update({ name, updated_at: new Date() });
            }
            return Number(row.id);
        }

        const [ins] = await db(TABLES.PRE_PARTICIPANTS)
            .insert({
                pre_sport_id: preSportId,
                name,
                short_name,
                participant_type: 'individual',
                metadata: db.raw(`'{}'::jsonb`),
                created_at: new Date(),
                updated_at: new Date(),
            })
            .returning('id');

        return Number(ins.id);
    }

    /**
     * Create or update fs_pre_event_entries on (pre_event_id, pre_participant_id); merge metadata jsonb.
     */
    static async createOrUpdatePreEventParticipant(
        data: {
            pre_event_id: number;
            pre_participant_id: number;
            provider_participant_ref_id: string;
            draw_number?: number;
            display_name?: string;
            slug?: string;
            jockey?: string;
            participant_status_id?: number;
            position?: number;
            entry_status?: string;
            role?: string;
            seed?: number | null;
            draw_position?: number | null;
            finishing_position?: number | null;
            extra_info: string;
        },
        trx?: Knex.Transaction
    ): Promise<number> {
        const db = trx || this.db;

        const existing = await db(`${TABLES.PRE_EVENT_PARTICIPANTS} as pee`)
            .join(`${TABLES.PRE_PARTICIPANTS} as p`, 'pee.pre_participant_id', 'p.id')
            .where('pee.pre_event_id', data.pre_event_id)
            .where('pee.pre_participant_id', data.pre_participant_id)
            .select('pee.*', 'p.name as display_name')
            .first();

        const isNew = !existing;

        const adapter = getSportAdapter();

        const insertData: Record<string, any> = {
            pre_event_id: data.pre_event_id,
            pre_participant_id: data.pre_participant_id,
            position: data.position,
            metadata: db.raw(`COALESCE(?::jsonb, '{}'::jsonb)`, [data.extra_info]),
            created_at: new Date(),
            updated_at: new Date(),
        };

        const mergeData: Record<string, any> = {
            position: data.position,
            metadata: db.raw(
                `COALESCE(${TABLES.PRE_EVENT_PARTICIPANTS}.metadata, '{}'::jsonb) || ?::jsonb`,
                [data.extra_info]
            ),
            updated_at: new Date(),
        };

        if (data.role !== undefined) {
            insertData.role = data.role;
            mergeData.role = data.role;
        }
        if (data.entry_status !== undefined) {
            insertData.entry_status = data.entry_status;
            mergeData.entry_status = data.entry_status;
        }
        if (data.seed !== undefined) {
            insertData.seed = data.seed;
            mergeData.seed = data.seed;
        }
        if (data.draw_position !== undefined) {
            insertData.draw_position = data.draw_position;
            mergeData.draw_position = data.draw_position;
        }
        if (data.finishing_position !== undefined) {
            insertData.finishing_position = data.finishing_position;
            mergeData.finishing_position = data.finishing_position;
        }

        adapter.hooks.participant.applyPreEventParticipantFields({
            data,
            insertData,
            mergeData,
        });

        const [preRow] = await db(TABLES.PRE_EVENT_PARTICIPANTS)
            .insert(insertData)
            .onConflict(['pre_event_id', 'pre_participant_id'])
            .merge(mergeData)
            .returning('id');

        const entryId = Number(preRow.id);
        const newStatusId = data.participant_status_id || adapter.hooks.participant.getDefaultParticipantStatusId();

        const historyPolicy = adapter.hooks.participant.getHistoryPolicy();
        if (historyPolicy.trackHistory && TABLES.PRE_EVENT_PARTICIPANTS_HISTORY) {
            const afterUpsert = await db(`${TABLES.PRE_EVENT_PARTICIPANTS} as pee`)
                .join(`${TABLES.PRE_PARTICIPANTS} as p`, 'pee.pre_participant_id', 'p.id')
                .where('pee.id', entryId)
                .select('pee.*', 'p.name as display_name')
                .first();

            const mergedMeta = parseMetadata(afterUpsert?.metadata);

            const snapshotPosition = afterUpsert?.position != null ? String(afterUpsert.position) : null;
            const snapshotJockey = historyPolicy.includeJockeyColumn ? (afterUpsert as any)?.jockey ?? null : null;
            const snapshotRunner = afterUpsert?.display_name ?? null;
            const snapshotStatusId = (afterUpsert as any)?.participant_status_id ?? newStatusId;

            try {
                if (isNew) {
                    const historyRecord: any = {
                        pre_event_participant_id: entryId,
                        pre_event_id: data.pre_event_id,
                        position: snapshotPosition,
                        participant_status_id: snapshotStatusId,
                        change_type: 'status',
                        extra_info: {
                            ...mergedMeta,
                            reason: 'initial_creation',
                            initial_status: snapshotStatusId,
                            initial_display_name: snapshotRunner,
                            initial_position: snapshotPosition,
                        },
                    };
                    if (historyPolicy.includeJockeyColumn) {
                        historyRecord.jockey = snapshotJockey;
                        historyRecord.extra_info.initial_jockey = snapshotJockey;
                    }
                    historyRecord.runner = snapshotRunner;

                    await PreEventParticipantHistoryRepository.insert(historyRecord, db as Knex.Transaction);
                } else {
                    if ((existing as any).participant_status_id !== newStatusId) {
                        const historyRecord: any = {
                            pre_event_participant_id: entryId,
                            pre_event_id: data.pre_event_id,
                            position: snapshotPosition,
                            runner: snapshotRunner,
                            participant_status_id: snapshotStatusId,
                            change_type: 'status',
                            extra_info: {
                                ...mergedMeta,
                                previous_status_id: (existing as any).participant_status_id,
                                new_status_id: newStatusId,
                            },
                        };
                        if (historyPolicy.includeJockeyColumn) historyRecord.jockey = snapshotJockey;
                        await PreEventParticipantHistoryRepository.insert(historyRecord, db as Knex.Transaction);
                    }

                    if (historyPolicy.includeJockeyColumn && data.jockey && normalize((existing as any).jockey) !== normalize(data.jockey)) {
                        await PreEventParticipantHistoryRepository.insert({
                            pre_event_participant_id: entryId,
                            pre_event_id: data.pre_event_id,
                            position: snapshotPosition,
                            jockey: data.jockey,
                            runner: snapshotRunner,
                            participant_status_id: snapshotStatusId,
                            change_type: 'jockey',
                            extra_info: {
                                ...mergedMeta,
                                previous_jockey: (existing as any).jockey,
                                new_jockey: data.jockey,
                                reason: 'jockey_change',
                            },
                        }, db as Knex.Transaction);
                    }

                    if (data.display_name && normalize(existing.display_name) !== normalize(data.display_name)) {
                        const historyRecord: any = {
                            pre_event_participant_id: entryId,
                            pre_event_id: data.pre_event_id,
                            position: snapshotPosition,
                            runner: data.display_name,
                            participant_status_id: snapshotStatusId,
                            change_type: 'runner',
                            extra_info: {
                                ...mergedMeta,
                                previous_display_name: existing.display_name,
                                new_display_name: data.display_name,
                                reason: 'runner_change',
                            },
                        };
                        if (historyPolicy.includeJockeyColumn) historyRecord.jockey = snapshotJockey;
                        await PreEventParticipantHistoryRepository.insert(historyRecord, db as Knex.Transaction);
                    }

                    if (data.position != null && existing.position !== data.position) {
                        const historyRecord: any = {
                            pre_event_participant_id: entryId,
                            pre_event_id: data.pre_event_id,
                            position: String(data.position),
                            runner: snapshotRunner,
                            participant_status_id: snapshotStatusId,
                            change_type: 'position',
                            extra_info: {
                                ...mergedMeta,
                                previous_position: existing.position != null ? String(existing.position) : null,
                                new_position: String(data.position),
                            },
                        };
                        if (historyPolicy.includeJockeyColumn) historyRecord.jockey = snapshotJockey;
                        await PreEventParticipantHistoryRepository.insert(historyRecord, db as Knex.Transaction);
                    }
                }
            } catch (error) {
                logger.error('Failed to write pre-event participant history', error as Error, {
                    preEventParticipantId: entryId,
                    preEventId: data.pre_event_id,
                });
            }
        }

        return entryId;
    }

    /**
     * Get canonical entry by pre_event_id and stable participant short_name (fs_pre_participants.short_name)
     */
    static async getPreEventParticipant(
        preEventId: number,
        participantShortName: string,
        trx?: Knex.Transaction
    ): Promise<any | null> {
        const db = trx || this.db;
        const sn = this.truncateShortName(participantShortName);
        const row = await db(`${TABLES.PRE_EVENT_PARTICIPANTS} as pee`)
            .join(`${TABLES.PRE_PARTICIPANTS} as p`, 'pee.pre_participant_id', 'p.id')
            .where('pee.pre_event_id', preEventId)
            .where('p.short_name', sn)
            .select(
                'pee.*',
                'pee.id as id',
                'p.name as display_name',
                'p.short_name as slug',
                'p.short_name as ref_id'
            )
            .first();

        if (!row) return null;
        return {
            ...row,
            extra_info: typeof row.metadata === 'string' ? row.metadata : JSON.stringify(row.metadata ?? {}),
        };
    }

    static async getByPreEventId(preEventId: number, trx?: Knex.Transaction): Promise<any[]> {
        const db = trx || this.db;
        const rows = await db(`${TABLES.PRE_EVENT_PARTICIPANTS} as pee`)
            .join(`${TABLES.PRE_PARTICIPANTS} as p`, 'pee.pre_participant_id', 'p.id')
            .where('pee.pre_event_id', preEventId)
            .select(
                'pee.*',
                'pee.id as id',
                'p.name as display_name',
                'p.short_name as slug',
                'p.short_name as ref_id',
                'p.id as pre_participant_id'
            );

        return rows.map((row) => ({
            ...row,
            extra_info: typeof row.metadata === 'string' ? row.metadata : JSON.stringify(row.metadata ?? {}),
        }));
    }

    static async getMatchingStats(): Promise<{
        totalProviderParticipants: number;
        linkedParticipants: number;
        unlinkedParticipants: number;
        preEventParticipants: number;
    }> {
        const totalProviderParticipants = await this.db(TABLES.PROVIDER_EVENT_PARTICIPANTS)
            .count('* as count')
            .first();

        const linkedParticipants = await this.db(TABLES.PROVIDER_EVENT_PARTICIPANTS)
            .whereNotNull('pre_event_entry_id')
            .count('* as count')
            .first();

        const unlinkedParticipants = await this.db(TABLES.PROVIDER_EVENT_PARTICIPANTS)
            .whereNull('pre_event_entry_id')
            .count('* as count')
            .first();

        const preEventParticipants = await this.db(TABLES.PRE_EVENT_PARTICIPANTS)
            .count('* as count')
            .first();

        return {
            totalProviderParticipants: parseInt(String(totalProviderParticipants?.count || '0')),
            linkedParticipants: parseInt(String(linkedParticipants?.count || '0')),
            unlinkedParticipants: parseInt(String(unlinkedParticipants?.count || '0')),
            preEventParticipants: parseInt(String(preEventParticipants?.count || '0'))
        };
    }

    static async updatePosition(
        preEventEntryId: number,
        position: number,
        sourceProviderId: number,
        trx: Knex.Transaction
    ): Promise<void> {
        const current = await trx(`${TABLES.PRE_EVENT_PARTICIPANTS} as pee`)
            .join(`${TABLES.PRE_PARTICIPANTS} as p`, 'pee.pre_participant_id', 'p.id')
            .where('pee.id', preEventEntryId)
            .select('pee.*', 'p.name as display_name')
            .first();

        await trx(TABLES.PRE_EVENT_PARTICIPANTS)
            .where('id', preEventEntryId)
            .update({
                position,
                updated_at: new Date()
            });

        const historyPolicy = getSportAdapter().hooks.participant.getHistoryPolicy();
        if (historyPolicy.trackHistory && TABLES.PRE_EVENT_PARTICIPANTS_HISTORY && current && current.position !== position) {
            try {
                const mergedMeta = parseMetadata(current.metadata);

                const historyRecord: any = {
                    pre_event_participant_id: preEventEntryId,
                    pre_event_id: current.pre_event_id,
                    position: String(position),
                    runner: current.display_name ?? null,
                    participant_status_id: (current as any).participant_status_id ?? null,
                    change_type: 'position',
                    extra_info: {
                        ...mergedMeta,
                        previous_position: current.position != null ? String(current.position) : null,
                        new_position: String(position),
                        source_provider_id: sourceProviderId,
                    },
                };
                if (historyPolicy.includeJockeyColumn) historyRecord.jockey = (current as any).jockey ?? null;

                await PreEventParticipantHistoryRepository.insert(historyRecord, trx);
            } catch (error) {
                logger.error('Failed to write position history', error as Error, {
                    preEventParticipantId: preEventEntryId,
                    position,
                });
            }
        }
    }

    static async getAllActiveByPreEventId(
        preEventId: number,
        trx: Knex.Transaction
    ): Promise<any[]> {
        const adapter = getSportAdapter();
        const query = trx(`${TABLES.PRE_EVENT_PARTICIPANTS} as pee`)
            .join(`${TABLES.PRE_PARTICIPANTS} as p`, 'pee.pre_participant_id', 'p.id')
            .where('pee.pre_event_id', preEventId)
            .select(
                'pee.*',
                'pee.id as id',
                'p.name as display_name',
                'p.short_name as ref_id'
            );

        if (adapter.hooks.participant.isActiveParticipantFilterEnabled()) {
            query.where('pee.entry_status', 'active');
        }

        const rows = await query;
        return rows.map((row) => ({
            ...row,
            extra_info: typeof row.metadata === 'string' ? row.metadata : JSON.stringify(row.metadata ?? {}),
        }));
    }

    static async getById(
        preEventEntryId: number,
        trx?: Knex.Transaction
    ): Promise<any | null> {
        const db = trx || this.db;
        const row = await db(`${TABLES.PRE_EVENT_PARTICIPANTS} as pee`)
            .join(`${TABLES.PRE_PARTICIPANTS} as p`, 'pee.pre_participant_id', 'p.id')
            .where('pee.id', preEventEntryId)
            .select(
                'pee.*',
                'pee.id as id',
                'p.name as display_name',
                'p.short_name as slug',
                'p.short_name as ref_id'
            )
            .first();

        if (!row) return null;
        return {
            ...row,
            extra_info: typeof row.metadata === 'string' ? row.metadata : JSON.stringify(row.metadata ?? {}),
        };
    }
}
