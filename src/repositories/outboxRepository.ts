/**
 * Outbox Repository
 * Database operations for outbox_events
 */

import { Knex } from 'knex';
import { DatabaseService } from '../utils/database.js';
import { TABLES } from '../constants/tables.js';

export class OutboxRepository {
    private static db = DatabaseService.getInstance();

    static async insertOutboxEvent(
        data: {
            event_type: string;
            aggregate_key: string;
            payload: any;
            version: number;
            created_at?: Date;
        },
        trx?: Knex.Transaction
    ): Promise<void> {
        const db = trx || this.db;
        const payloadJson = typeof data.payload === 'string' ? data.payload : JSON.stringify(data.payload);

        await db(TABLES.OUTBOX_EVENTS)
            .insert({
                event_type: data.event_type,
                aggregate_key: data.aggregate_key,
                payload: db.raw('?::jsonb', [payloadJson]),
                version: data.version,
                created_at: data.created_at ?? new Date()
            })
            .onConflict(['aggregate_key', 'version'])
            .ignore();
    }
}
