#!/usr/bin/env node
/**
 * Operational helper: reset polling cursors stored in `fs_agg_polling_cursors`.
 *
 * Usage:
 *   node scripts/reset-cursor.js                 # delete ALL cursors
 *   node scripts/reset-cursor.js <table_name>    # delete cursor for one table
 *   node scripts/reset-cursor.js <table_name> --to '2026-04-01T00:00:00Z'
 *                                                # set cursor to a specific time
 *
 * After deleting a cursor row, the polling service will bootstrap that
 * table from `now() - POLL_CATCHUP_MINUTES` on the next start.
 */

import 'dotenv/config';
import knex from 'knex';
import { DATABASE_CONFIG } from '../dist/src/config/index.js';

const TABLE = 'fs_agg_polling_cursors';

async function main() {
    const args = process.argv.slice(2);
    const tableName = args[0] && !args[0].startsWith('--') ? args[0] : null;
    const toIdx = args.indexOf('--to');
    const toValue = toIdx !== -1 ? args[toIdx + 1] : null;

    const db = knex({
        client: 'pg',
        connection: DATABASE_CONFIG,
    });

    try {
        if (!tableName) {
            const deleted = await db(TABLE).delete();
            console.log(`✓ Deleted ${deleted} cursor row(s) from ${TABLE}`);
        } else if (toValue) {
            const ts = new Date(toValue);
            if (Number.isNaN(ts.getTime())) {
                throw new Error(`Invalid --to timestamp: ${toValue}`);
            }
            await db(TABLE)
                .insert({
                    table_name: tableName,
                    last_updated_at: ts,
                    last_id: 0,
                    updated_at: new Date(),
                })
                .onConflict('table_name')
                .merge({
                    last_updated_at: ts,
                    last_id: 0,
                    updated_at: new Date(),
                });
            console.log(`✓ Cursor for ${tableName} set to ${ts.toISOString()}`);
        } else {
            const deleted = await db(TABLE).where('table_name', tableName).delete();
            console.log(`✓ Deleted ${deleted} cursor row(s) for ${tableName}`);
        }
    } finally {
        await db.destroy();
    }
}

main().catch((err) => {
    console.error('❌ reset-cursor error:', err);
    process.exit(1);
});
