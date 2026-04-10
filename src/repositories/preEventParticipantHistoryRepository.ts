/**
 * Pre Event Participant History Repository
 * Database operations for tracking pre-event-participant changes at the pre layer.
 * Mirrors the provider-layer participant history table but represents
 * the MERGED state from all matched providers.
 *
 * Each history record is a FULL SNAPSHOT of the pre-participant at the time of change,
 * matching the provider-layer pattern where all fields are populated (not just the changed one).
 */

import { KnexClient } from '../config/knex.js';
import { Knex } from 'knex';
import { TABLES } from '../constants/tables.js';
import { logger } from '../utils/logger.js';
import { getSportAdapter } from '../adapters/index.js';

/**
 * Change type for participant history records.
 * Common values: 'position', 'status', 'name'.
 * Sport-specific values added by adapters (e.g. 'jockey' for horse racing).
 */
export type PreParticipantChangeType = string;

export interface PreParticipantHistoryRecord {
    pre_event_participant_id: number;
    pre_event_id: number;
    position: string | null;
    /** Sport-specific: only populated for sports with jockey tracking */
    jockey?: string | null;
    /** Display name / runner name snapshot at time of change */
    runner?: string | null;
    participant_status_id: number | null;
    change_type: PreParticipantChangeType;
    extra_info: Record<string, any> | null;
}

export class PreEventParticipantHistoryRepository {
    private static db = KnexClient.getInstance();

    /**
     * Insert a history record for a pre-event participant change.
     * Each record is a full snapshot of the participant at the time of change.
     */
    static async insert(
        record: PreParticipantHistoryRecord,
        trx?: Knex.Transaction
    ): Promise<void> {
        const db = trx || this.db;

        try {
            const historyPolicy = getSportAdapter().hooks.participant.getHistoryPolicy();
            const insertData: Record<string, any> = {
                pre_event_participant_id: record.pre_event_participant_id,
                pre_event_id: record.pre_event_id,
                position: record.position,
                participant_status_id: record.participant_status_id,
                change_type: record.change_type,
                extra_info: record.extra_info ? JSON.stringify(record.extra_info) : null,
                created_at: new Date(),
            };
            // Only include jockey/runner columns for sports that have them in the history table
            if (historyPolicy.includeJockeyColumn) {
                insertData.jockey = record.jockey;
            }
            // runner column exists on horse-racing history but not golf
            // Golf history only has: position, participant_status_id, change_type
            if (historyPolicy.includeRunnerColumn) {
                insertData.runner = record.runner;
            }
            await db(TABLES.PRE_EVENT_PARTICIPANTS_HISTORY).insert(insertData);
        } catch (error) {
            logger.error('Failed to insert pre-event participant history', error as Error, {
                preEventParticipantId: record.pre_event_participant_id,
                preEventId: record.pre_event_id,
                changeType: record.change_type,
            });
            throw error;
        }
    }

    /**
     * Get latest history record for a pre-event participant
     */
    static async getLatestRecord(
        preEventParticipantId: number,
        trx?: Knex.Transaction
    ): Promise<any | null> {
        const db = trx || this.db;
        return await db(TABLES.PRE_EVENT_PARTICIPANTS_HISTORY)
            .where('pre_event_participant_id', preEventParticipantId)
            .orderBy('created_at', 'desc')
            .first() || null;
    }

    /**
     * Get latest history record for a pre-event participant filtered by change type
     */
    static async getLatestByType(
        preEventParticipantId: number,
        changeType: PreParticipantChangeType,
        trx?: Knex.Transaction
    ): Promise<any | null> {
        const db = trx || this.db;
        return await db(TABLES.PRE_EVENT_PARTICIPANTS_HISTORY)
            .where('pre_event_participant_id', preEventParticipantId)
            .where('change_type', changeType)
            .orderBy('created_at', 'desc')
            .first() || null;
    }
}
