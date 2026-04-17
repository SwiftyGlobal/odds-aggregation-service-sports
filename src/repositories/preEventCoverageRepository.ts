/**
 * Pre Event Coverage Repository
 * Database operations for pre-event coverage computation.
 *
 * Sports schema (v2) persists only `linked_provider_ids` on fs_pre_events.
 * Fine-grained coverage (which providers contribute entries/markets/selections)
 * lives on the child tables via their own `linked_provider_ids` arrays.
 */

import { Knex } from 'knex';
import { TABLES } from '../constants/tables.js';

export class PreEventCoverageRepository {
    /**
     * Compute the set of provider_ids with any provider_event row linked to this pre-event.
     *
     * @param preEventId - The pre-event ID
     * @param trx - Transaction (required)
     * @returns Sorted, deduplicated provider IDs
     */
    static async computeLinkedProviderIds(
        preEventId: number,
        trx: Knex.Transaction
    ): Promise<number[]> {
        const rows = await trx(TABLES.PROVIDER_EVENTS)
            .where('pre_event_id', preEventId)
            .select('provider_id')
            .distinct();

        return Array.from(new Set(rows.map((r) => r.provider_id))).sort((a, b) => a - b);
    }
}
