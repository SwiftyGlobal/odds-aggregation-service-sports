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
}
