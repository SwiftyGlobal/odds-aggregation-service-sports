/**
 * Pre Event Participant Repository
 * Database operations for pre-event-participants
 */

import { KnexClient } from '../config/knex.js';
import { Knex } from 'knex';
import { TABLES } from '../constants/tables.js';
import { PreEventParticipantHistoryRepository } from './preEventParticipantHistoryRepository.js';
import { logger } from '../utils/logger.js';
import { buildParticipantRefId, extractParticipantName } from '../utils/refIdUtils.js';
import { getSportAdapter } from '../adapters/index.js';

/**
 * Parse extra_info from DB row (handles both string and object forms)
 */
function parseExtraInfo(raw: any): Record<string, any> | null {
    if (!raw) return null;
    if (typeof raw === 'object') return raw;
    try { return JSON.parse(raw); } catch { return null; }
}

/**
 * Normalize a string for comparison — case-insensitive, trimmed.
 * Returns null for null/undefined/empty so null === null comparisons work.
 */
function normalize(val: string | null | undefined): string | null {
    if (!val) return null;
    const trimmed = val.trim().toLowerCase();
    return trimmed || null;
}

export class PreEventParticipantRepository {
    private static db = KnexClient.getInstance();

    /**
     * Create or update pre-event-participant with JSONB merge
     * Now uses ref_id for uniqueness instead of pre_participant_id
     * ref_id is auto-generated from parent event's ref_id + participant name
     */
    static async createOrUpdatePreEventParticipant(
        data: {
            pre_event_id: number;
            provider_participant_ref_id: string;  // provider's participant_ref_id (used as fallback for matching)
            draw_number?: number;
            display_name?: string;
            slug?: string;
            jockey?: string;
            participant_status_id?: number;
            position?: number;
            /** Canonical entry status — one of ENTRY_STATUS_VALUES. Omit to keep existing / use DB default. */
            entry_status?: string;
            /** Canonical entry role — one of ENTRY_ROLE_VALUES. Omit to keep existing / use DB default. */
            role?: string;
            /** Tournament seed (e.g. tennis seeding). */
            seed?: number | null;
            /** Starting draw position (e.g. golf tee-time order). */
            draw_position?: number | null;
            /** Final finishing position after settlement. */
            finishing_position?: number | null;
            extra_info: string; // JSON string
        },
        trx?: Knex.Transaction
    ): Promise<number> {
        const db = trx || this.db;

        // Generate stable ref_id from event ref_id + participant name
        // e.g. HR.202603051700.USA.charles_town.senorita_jerico
        // Always run through extractParticipantName() to handle cases where slug/display_name
        // contain full provider ref_ids (e.g. "202603051900.T.GBR.newcastle.6.castan")
        const rawName = data.slug || data.display_name || data.provider_participant_ref_id;
        const participantName = extractParticipantName(rawName);
        let refId: string;

        const parentEvent = await db(TABLES.PRE_EVENTS)
            .where('id', data.pre_event_id)
            .select('event_ref_id')
            .first();

        if (parentEvent?.event_ref_id && participantName) {
            refId = buildParticipantRefId(parentEvent.event_ref_id, participantName);
        } else {
            // Fallback: use provider's participant_ref_id directly
            refId = data.provider_participant_ref_id;
        }

        // Read existing record before upsert to detect changes
        const existing = await db(TABLES.PRE_EVENT_PARTICIPANTS)
            .where({
                pre_event_id: data.pre_event_id,
                entry_ref_id: refId
            })
            .first();

        const isNew = !existing;

        const adapter = getSportAdapter();

        // Build insert/merge data — only include sport-specific columns when adapter supports them
        const insertData: Record<string, any> = {
            pre_event_id: data.pre_event_id,
            entry_ref_id: refId,
            display_name: data.display_name,
            position: data.position,
            extra_info: data.extra_info,
            created_at: new Date(),
            updated_at: new Date()
        };

        const mergeData: Record<string, any> = {
            display_name: data.display_name,
            position: data.position,
            // Merge JSONB: existing || new (new fields override existing, but keep all unique fields)
            extra_info: db.raw(`COALESCE(${TABLES.PRE_EVENT_PARTICIPANTS}.extra_info, '{}'::jsonb) || ?::jsonb`, [data.extra_info]),
            updated_at: new Date()
        };

        // Propagate canonical-entry fields from the provider layer.
        // Only set when the caller supplied a value — leaving the column untouched
        // on merge preserves whatever the previous provider wrote, and lets the
        // DB default ('active' / 'participant') apply on insert.
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

        const [preEventParticipant] = await db(TABLES.PRE_EVENT_PARTICIPANTS)
            .insert(insertData)
            .onConflict(['pre_event_id', 'entry_ref_id'])
            .merge(mergeData)
            .returning('id');

        const participantId = preEventParticipant.id;
        const newStatusId = data.participant_status_id || adapter.hooks.participant.getDefaultParticipantStatusId();

        const historyPolicy = adapter.hooks.participant.getHistoryPolicy();
        // Only write history for sports that track participant history
        if (historyPolicy.trackHistory && TABLES.PRE_EVENT_PARTICIPANTS_HISTORY) {
            // Re-read after upsert to get the actual merged extra_info from DB
            const afterUpsert = await db(TABLES.PRE_EVENT_PARTICIPANTS)
                .where('id', participantId)
                .first();

            const mergedExtraInfo = parseExtraInfo(afterUpsert?.extra_info);

            // Build full snapshot values (what the record looks like NOW after upsert)
            const snapshotPosition = afterUpsert?.position != null ? String(afterUpsert.position) : null;
            const snapshotJockey = historyPolicy.includeJockeyColumn ? (afterUpsert?.jockey ?? null) : null;
            const snapshotRunner = afterUpsert?.display_name ?? null;
            const snapshotStatusId = afterUpsert?.participant_status_id ?? newStatusId;

            // Write history records — full snapshots matching provider-layer pattern
            try {
                if (isNew) {
                    // Initial creation — record as 'status' with reason: 'initial_creation'
                    const historyRecord: any = {
                        pre_event_participant_id: participantId,
                        pre_event_id: data.pre_event_id,
                        position: snapshotPosition,
                        participant_status_id: snapshotStatusId,
                        change_type: 'status',
                        extra_info: {
                            ...mergedExtraInfo,
                            reason: 'initial_creation',
                            initial_status: snapshotStatusId,
                            initial_display_name: snapshotRunner,
                            initial_position: snapshotPosition,
                        },
                    };
                    // Only include jockey/runner fields if the adapter policy supports them
                    if (historyPolicy.includeJockeyColumn) {
                        historyRecord.jockey = snapshotJockey;
                        historyRecord.extra_info.initial_jockey = snapshotJockey;
                    }
                    historyRecord.runner = snapshotRunner;

                    await PreEventParticipantHistoryRepository.insert(historyRecord, db as Knex.Transaction);
                } else {
                    // Existing participant — detect changes, write full snapshots

                    if (existing.participant_status_id !== newStatusId) {
                        const historyRecord: any = {
                            pre_event_participant_id: participantId,
                            pre_event_id: data.pre_event_id,
                            position: snapshotPosition,
                            runner: snapshotRunner,
                            participant_status_id: snapshotStatusId,
                            change_type: 'status',
                            extra_info: {
                                ...mergedExtraInfo,
                                previous_status_id: existing.participant_status_id,
                                new_status_id: newStatusId,
                            },
                        };
                        if (historyPolicy.includeJockeyColumn) historyRecord.jockey = snapshotJockey;
                        await PreEventParticipantHistoryRepository.insert(historyRecord, db as Knex.Transaction);
                    }

                    // Jockey change detection — only for sports with jockeys
                    if (historyPolicy.includeJockeyColumn && data.jockey && normalize(existing.jockey) !== normalize(data.jockey)) {
                        await PreEventParticipantHistoryRepository.insert({
                            pre_event_participant_id: participantId,
                            pre_event_id: data.pre_event_id,
                            position: snapshotPosition,
                            jockey: data.jockey,
                            runner: snapshotRunner,
                            participant_status_id: snapshotStatusId,
                            change_type: 'jockey',
                            extra_info: {
                                ...mergedExtraInfo,
                                previous_jockey: existing.jockey,
                                new_jockey: data.jockey,
                                reason: 'jockey_change',
                            },
                        }, db as Knex.Transaction);
                    }

                    if (data.display_name && normalize(existing.display_name) !== normalize(data.display_name)) {
                        const historyRecord: any = {
                            pre_event_participant_id: participantId,
                            pre_event_id: data.pre_event_id,
                            position: snapshotPosition,
                            runner: data.display_name,
                            participant_status_id: snapshotStatusId,
                            change_type: 'runner',
                            extra_info: {
                                ...mergedExtraInfo,
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
                            pre_event_participant_id: participantId,
                            pre_event_id: data.pre_event_id,
                            position: String(data.position),
                            runner: snapshotRunner,
                            participant_status_id: snapshotStatusId,
                            change_type: 'position',
                            extra_info: {
                                ...mergedExtraInfo,
                                previous_position: existing.position != null ? String(existing.position) : null,
                                new_position: String(data.position),
                            },
                        };
                        if (historyPolicy.includeJockeyColumn) historyRecord.jockey = snapshotJockey;
                        await PreEventParticipantHistoryRepository.insert(historyRecord, db as Knex.Transaction);
                    }
                }
            } catch (error) {
                // Log but don't fail the main operation — history is supplementary
                logger.error('Failed to write pre-event participant history', error as Error, {
                    preEventParticipantId: participantId,
                    preEventId: data.pre_event_id,
                });
            }
        }

        return participantId;
    }

    /**
     * Get pre-event-participant by pre_event_id and ref_id
     */
    static async getPreEventParticipant(
        preEventId: number,
        refId: string,
        trx?: Knex.Transaction
    ): Promise<any | null> {
        const db = trx || this.db;
        return await db(TABLES.PRE_EVENT_PARTICIPANTS)
            .where({
                pre_event_id: preEventId,
                entry_ref_id: refId
            })
            .first();
    }

    /**
     * Get all pre-event participants for a pre-event
     *
     * @param preEventId - The pre-event ID
     * @param trx - Optional transaction
     * @returns Array of pre-event participants
     */
    static async getByPreEventId(
        preEventId: number,
        trx?: Knex.Transaction
    ): Promise<any[]> {
        const db = trx || this.db;
        return await db(TABLES.PRE_EVENT_PARTICIPANTS)
            .where('pre_event_id', preEventId);
    }

    /**
     * Get matching statistics
     */
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

    /**
     * Update position with source tracking
     *
     * @param preEventParticipantId - The pre-event participant ID
     * @param position - The position to set
     * @param sourceProviderId - The provider that supplied the position
     * @param trx - Transaction (required)
     */
    static async updatePosition(
        preEventParticipantId: number,
        position: number,
        sourceProviderId: number,
        trx: Knex.Transaction
    ): Promise<void> {
        // Read current to check if position actually changed
        const current = await trx(TABLES.PRE_EVENT_PARTICIPANTS)
            .where('id', preEventParticipantId)
            .first();

        await trx(TABLES.PRE_EVENT_PARTICIPANTS)
            .where('id', preEventParticipantId)
            .update({
                position,
                updated_at: new Date()
            });

        // Record position history if value changed — full snapshot (only for sports with status tracking)
        const historyPolicy = getSportAdapter().hooks.participant.getHistoryPolicy();
        if (historyPolicy.trackHistory && TABLES.PRE_EVENT_PARTICIPANTS_HISTORY && current && current.position !== position) {
            try {
                const mergedExtraInfo = parseExtraInfo(current.extra_info);

                const historyRecord: any = {
                    pre_event_participant_id: preEventParticipantId,
                    pre_event_id: current.pre_event_id,
                    position: String(position),
                    runner: current.display_name ?? null,
                    participant_status_id: current.participant_status_id ?? null,
                    change_type: 'position',
                    extra_info: {
                        ...mergedExtraInfo,
                        previous_position: current.position != null ? String(current.position) : null,
                        new_position: String(position),
                        source_provider_id: sourceProviderId,
                    },
                };
                if (historyPolicy.includeJockeyColumn) historyRecord.jockey = current.jockey ?? null;

                await PreEventParticipantHistoryRepository.insert(historyRecord, trx);
            } catch (error) {
                logger.error('Failed to write position history', error as Error, {
                    preEventParticipantId,
                    position,
                });
            }
        }
    }

    /**
     * Get all active pre-event participants for a pre-event
     * Active = participant_status_id = 1 (normal/running)
     *
     * @param preEventId - The pre-event ID
     * @param trx - Transaction (required)
     * @returns Array of active pre-event participants
     */
    static async getAllActiveByPreEventId(
        preEventId: number,
        trx: Knex.Transaction
    ): Promise<any[]> {
        const adapter = getSportAdapter();
        const query = trx(TABLES.PRE_EVENT_PARTICIPANTS)
            .where('pre_event_id', preEventId);

        // Only filter by status for sports that have participant status tracking
        if (adapter.hooks.participant.isActiveParticipantFilterEnabled()) {
            query.where('participant_status_id', adapter.hooks.participant.getDefaultParticipantStatusId());
        }

        return await query;
    }

    /**
     * Get pre-event participant by ID
     *
     * @param preEventParticipantId - The pre-event participant ID
     * @param trx - Optional transaction
     * @returns Pre-event participant or null
     */
    static async getById(
        preEventParticipantId: number,
        trx?: Knex.Transaction
    ): Promise<any | null> {
        const db = trx || this.db;
        return await db(TABLES.PRE_EVENT_PARTICIPANTS)
            .where('id', preEventParticipantId)
            .first();
    }
}
