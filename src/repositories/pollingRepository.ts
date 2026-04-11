/**
 * Polling Repository
 * Encapsulates database queries for the polling-based change detection system.
 */

import { DatabaseService } from '../utils/database.js';
import { logger } from '../utils/logger.js';
import { getSportAdapter } from '../adapters/index.js';

/** Primary key value from a polled row (table-specific tie-break column). */
export function getPolledRowPrimaryKey(table: string, row: Record<string, unknown>): number {
    const col = getSportAdapter().polling.orderByIdColumn?.[table] ?? 'id';
    const v = row[col] ?? row.id;
    return Number(v);
}

export class PollingRepository {
    /**
     * Get rows changed since a given timestamp for a specific table.
     * Uses updated_at with id ordering to handle microsecond ties.
     */
    static async getChangedRows(
        table: string,
        since: Date,
        limit: number
    ): Promise<any[]> {
        const db = DatabaseService.getInstance();

        const idColumn =
            getSportAdapter().polling.orderByIdColumn?.[table] ?? 'id';

        const rows = await db(table)
            .where('updated_at', '>', since)
            .orderBy([
                { column: 'updated_at', order: 'asc' },
                { column: idColumn, order: 'asc' }
            ])
            .limit(limit);

        return rows;
    }

    /**
     * Get the current server time.
     * Used to initialize poll baseline with clock-consistent timing.
     */
    static async getServerTime(): Promise<Date> {
        const db = DatabaseService.getInstance();
        const result = await db.raw('SELECT NOW() AS server_time');
        return new Date(result.rows[0].server_time);
    }

    /**
     * Load all persisted polling cursors from `fs_agg_polling_cursors`.
     * The aggregation service is the sole writer of this table.
     */
    static async loadAllCursors(): Promise<
        Map<string, { lastUpdatedAt: Date; lastId: number }>
    > {
        const db = DatabaseService.getInstance();
        const rows = await db('fs_agg_polling_cursors').select(
            'table_name',
            'last_updated_at',
            'last_id'
        );
        const out = new Map<string, { lastUpdatedAt: Date; lastId: number }>();
        for (const row of rows) {
            out.set(row.table_name, {
                lastUpdatedAt: new Date(row.last_updated_at),
                lastId: Number(row.last_id ?? 0),
            });
        }
        return out;
    }

    /**
     * Upsert a polling cursor for a single table.
     */
    static async upsertCursor(
        tableName: string,
        lastUpdatedAt: Date,
        lastId: number
    ): Promise<void> {
        const db = DatabaseService.getInstance();
        await db('fs_agg_polling_cursors')
            .insert({
                table_name: tableName,
                last_updated_at: lastUpdatedAt,
                last_id: lastId,
                updated_at: new Date(),
            })
            .onConflict('table_name')
            .merge({
                last_updated_at: lastUpdatedAt,
                last_id: lastId,
                updated_at: new Date(),
            });
    }
}
