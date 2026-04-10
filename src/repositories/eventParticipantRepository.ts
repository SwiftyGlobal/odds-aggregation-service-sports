/**
 * Event Participant Repository
 * Database operations for provider event participants
 */

import { DatabaseService } from '../utils/database.js';
import { Knex } from 'knex';
import { TABLES } from '../constants/tables.js';
import { getSportAdapter } from '../adapters/index.js';

function metadataToExtraInfoString(metadata: unknown): string | null {
    if (metadata == null) return null;
    if (typeof metadata === 'string') return metadata;
    try {
        return JSON.stringify(metadata);
    } catch {
        return null;
    }
}

function mapProviderEventEntryRow(row: Record<string, any> | undefined): any | null {
    if (!row) return null;
    const meta = row.pp_metadata ?? row.metadata;
    const extraInfo = metadataToExtraInfoString(meta);
    return {
        ...row,
        id: row.id,
        provider_entry_id: row.id,
        participant_ref_id: row.pp_participant_ref ?? row.participant_ref_id ?? row.entry_ref_id,
        slug: row.slug ?? row.pp_participant_ref ?? row.participant_ref_id,
        display_name:
            row.display_name ??
            row.pp_name ??
            (typeof row.entry_ref_id === 'string' ? row.entry_ref_id : undefined),
        extra_info: row.extra_info ?? extraInfo,
        pre_event_participant_id: row.pre_event_participant_id ?? row.pre_event_entry_id,
    };
}

export class EventParticipantRepository {
    private static db = DatabaseService.getInstance();

    /**
     * Get provider event participant by ID (fs_provider_event_entries.id)
     */
    static async getProviderEventParticipant(
        providerEventParticipantId: number,
        trx?: Knex.Transaction
    ): Promise<any | null> {
        const db = trx || this.db;
        const row = await db(`${TABLES.PROVIDER_EVENT_PARTICIPANTS} as pep`)
            .leftJoin(`${TABLES.PROVIDER_PARTICIPANTS} as pp`, 'pep.provider_participant_id', 'pp.id')
            .where('pep.id', providerEventParticipantId)
            .select(
                'pep.*',
                'pp.name as pp_name',
                'pp.participant_ref_id as pp_participant_ref',
                'pp.metadata as pp_metadata'
            )
            .first();

        if (!row) return null;

        const mapped = mapProviderEventEntryRow({
            ...row,
            display_name: row.pp_name,
        });
        return mapped;
    }

    /**
     * Link provider entry to canonical pre-event entry and pre-participant
     */
    static async updatePreEventParticipantId(
        providerEventParticipantId: number,
        preEventEntryId: number,
        preParticipantId: number,
        trx?: Knex.Transaction
    ): Promise<void> {
        const db = trx || this.db;
        await db(TABLES.PROVIDER_EVENT_PARTICIPANTS)
            .where('id', providerEventParticipantId)
            .update({
                pre_event_entry_id: preEventEntryId,
                pre_participant_id: preParticipantId,
                updated_at: new Date()
            });
    }

    /**
     * All provider event entries already linked to the same canonical pre_event_entry_id
     */
    static async getProviderEventParticipantsForPreEventParticipant(
        preEventEntryId: number,
        preEventId: number,
        trx?: Knex.Transaction
    ): Promise<Array<{ id: number; provider_id: number; extra_info: any }>> {
        const db = trx || this.db;
        const rows = await db(`${TABLES.PROVIDER_EVENT_PARTICIPANTS} as pep`)
            .join(`${TABLES.PROVIDER_EVENTS} as pe`, 'pe.id', 'pep.provider_event_id')
            .leftJoin(`${TABLES.PROVIDER_PARTICIPANTS} as pp`, 'pep.provider_participant_id', 'pp.id')
            .where('pe.pre_event_id', preEventId)
            .where('pep.pre_event_entry_id', preEventEntryId)
            .select(
                'pep.id',
                'pe.provider_id',
                'pep.metadata',
                'pp.metadata as pp_metadata'
            );

        return rows.map((r) => ({
            id: Number(r.id),
            provider_id: r.provider_id,
            extra_info: r.pp_metadata ?? r.metadata,
        }));
    }

    /**
     * Get provider event participants by provider event and pre-event participant
     *
     * @param providerEventId - The provider event ID
     * @param preEventParticipantId - Canonical fs_pre_event_entries.id
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
     * @param providerEventParticipantId - fs_provider_event_entries.id
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
            .leftJoin(`${TABLES.PROVIDER_PARTICIPANTS} as pp`, 'pep.provider_participant_id', 'pp.id')
            .where('pep.id', providerEventParticipantId)
            .select(
                'pep.*',
                'pe.provider_id',
                'pe.pre_event_id',
                'pp.name as pp_name',
                'pp.participant_ref_id as pp_participant_ref',
                'pp.metadata as pp_metadata'
            )
            .first();

        if (!result) return null;
        return mapProviderEventEntryRow({
            ...result,
            display_name: result.pp_name,
        });
    }
}
