/**
 * Failed Event Repository
 * Persists polling events that failed processing after all retries
 */

import { db } from '../config/knex.js';
import { TABLES } from '../constants/tables.js';

const TABLE = TABLES.FAILED_EVENTS;

export class FailedEventRepository {
    /**
     * Insert a failed event for later investigation.
     * Best-effort write — if it fails, the error is logged but not rethrown.
     */
    static async insert(params: {
        lsn: string;
        tableName: string;
        action: string;
        payload: Record<string, any>;
        errorMessage: string;
        errorCode: string;
    }): Promise<void> {
        await db(TABLE).insert({
            lsn: params.lsn,
            table_name: params.tableName,
            action: params.action,
            payload: JSON.stringify(params.payload),
            error_message: params.errorMessage,
            error_code: params.errorCode,
        });
    }
}
