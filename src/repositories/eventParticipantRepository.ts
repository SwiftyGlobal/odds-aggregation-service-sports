/**
 * Event Participant Repository
 * Database operations for provider event participants
 */

import { DatabaseService } from '../utils/database.js';
import { Knex } from 'knex';
import { TABLES } from '../constants/tables.js';
import { getSportAdapter } from '../adapters/index.js';

export class EventParticipantRepository {
    private static db = DatabaseService.getInstance();

    /**
     * Get provider event participant by ID
     */
    static async getProviderEventParticipant(
        providerEventParticipantId: number,
        trx?: Knex.Transaction
    ): Promise<any | null> {
        const db = trx || this.db;
        const row = await db(TABLES.PROVIDER_EVENT_PARTICIPANTS)
            .where('id', providerEventParticipantId)
            .first();
        if (!row) return null;
        return {
            ...row,
            participant_ref_id: row.participant_ref_id ?? row.entry_ref_id,
            pre_event_participant_id: row.pre_event_participant_id ?? row.pre_event_entry_id,
        };
    }

    /**
     * Update pre_event_participant_id for provider event participant
     */
    static async updatePreEventParticipantId(
        providerEventParticipantId: number,
        preEventParticipantId: number,
        trx?: Knex.Transaction
    ): Promise<void> {
        const db = trx || this.db;
        await db(TABLES.PROVIDER_EVENT_PARTICIPANTS)
            .where('id', providerEventParticipantId)
            .update({
                pre_event_entry_id: preEventParticipantId,
                updated_at: new Date()
            });
    }

    /**
     * Get all provider event participants for a given participant_ref_id and pre_event_id
     * Used to aggregate data from all providers for the same pre-event-participant
     */
    static async getProviderEventParticipantsForPreEventParticipant(
        participantRefId: string,
        preEventId: number,
        trx?: Knex.Transaction
    ): Promise<Array<{ id: number; provider_id: number; extra_info: any }>> {
        const db = trx || this.db;
        return await db(`${TABLES.PROVIDER_EVENT_PARTICIPANTS} as pep`)
            .join(`${TABLES.PROVIDER_EVENTS} as pe`, 'pe.id', 'pep.provider_event_id')
            .where('pep.entry_ref_id', participantRefId)
            .where('pe.pre_event_id', preEventId)
            .select('pep.id', 'pe.provider_id', 'pep.extra_info');
    }

    /**
     * Get provider event participants by provider event and pre-event participant
     * 
     * @param providerEventId - The provider event ID
     * @param preEventParticipantId - The pre-event participant ID
     * @param trx - Optional transaction
     * @returns Array of provider event participants
     */
    static async getByProviderEventAndPreParticipant(
        providerEventId: number,
        preEventParticipantId: number,
        trx?: Knex.Transaction
    ): Promise<any[]> {
        const db = trx || this.db;
        return await db(TABLES.PROVIDER_EVENT_PARTICIPANTS)
            .where('provider_event_id', providerEventId)
            .where('pre_event_entry_id', preEventParticipantId);
    }

    /**
     * Get all provider participants for a pre-event filtered by eligible provider IDs
     * Returns participants with their provider_id, position, and pre_event_participant_id
     * 
     * @param preEventId - The pre-event ID
     * @param eligibleProviderIds - Array of eligible provider IDs to filter by
     * @param trx - Transaction (required)
     * @returns Array of provider participants with provider info
     */
    static async getProviderParticipantsByPreEventId(
        preEventId: number,
        eligibleProviderIds: number[],
        trx: Knex.Transaction
    ): Promise<any[]> {
        if (eligibleProviderIds.length === 0) {
            return [];
        }

        const adapter = getSportAdapter();
        const selectColumns = adapter.hooks.participant.getProviderParticipantSelectColumns([
            'pep.id',
            'pep.pre_event_entry_id as pre_event_participant_id',
            'pep.position',
            'pe.provider_id',
        ]);

        return await trx(`${TABLES.PROVIDER_EVENT_PARTICIPANTS} as pep`)
            .join(`${TABLES.PROVIDER_EVENTS} as pe`, 'pe.id', 'pep.provider_event_id')
            .where('pe.pre_event_id', preEventId)
            .whereIn('pe.provider_id', eligibleProviderIds)
            .whereNotNull('pep.pre_event_entry_id')
            .select(selectColumns);
    }

    /**
     * Get match counts for provider participants for a pre-event
     * Used to determine when all participants are linked.
     */
    static async getProviderParticipantMatchCounts(
        preEventId: number,
        providerIds: number[],
        trx: Knex.Transaction
    ): Promise<{ total: number; matched: number }> {
        if (providerIds.length === 0) {
            return { total: 0, matched: 0 };
        }

        const totalResult = await trx(`${TABLES.PROVIDER_EVENT_PARTICIPANTS} as pep`)
            .join(`${TABLES.PROVIDER_EVENTS} as pe`, 'pe.id', 'pep.provider_event_id')
            .where('pe.pre_event_id', preEventId)
            .whereIn('pe.provider_id', providerIds)
            .count('* as count')
            .first();

        const matchedResult = await trx(`${TABLES.PROVIDER_EVENT_PARTICIPANTS} as pep`)
            .join(`${TABLES.PROVIDER_EVENTS} as pe`, 'pe.id', 'pep.provider_event_id')
            .where('pe.pre_event_id', preEventId)
            .whereIn('pe.provider_id', providerIds)
            .whereNotNull('pep.pre_event_entry_id')
            .count('* as count')
            .first();

        return {
            total: parseInt(String(totalResult?.count || '0'), 10),
            matched: parseInt(String(matchedResult?.count || '0'), 10)
        };
    }

    /**
     * Get provider event participant with its provider event info
     * 
     * @param providerEventParticipantId - The provider event participant ID
     * @param trx - Optional transaction
     * @returns Provider participant with event info or null
     */
    static async getProviderEventParticipantWithEvent(
        providerEventParticipantId: number,
        trx?: Knex.Transaction
    ): Promise<any | null> {
        const db = trx || this.db;
        const result = await db(`${TABLES.PROVIDER_EVENT_PARTICIPANTS} as pep`)
            .join(`${TABLES.PROVIDER_EVENTS} as pe`, 'pe.id', 'pep.provider_event_id')
            .where('pep.id', providerEventParticipantId)
            .select(
                'pep.*',
                'pe.provider_id',
                'pe.pre_event_id'
            )
            .first();

        if (!result) return null;
        return {
            ...result,
            participant_ref_id: result.participant_ref_id ?? result.entry_ref_id,
            pre_event_participant_id: result.pre_event_participant_id ?? result.pre_event_entry_id,
        };
    }
}
