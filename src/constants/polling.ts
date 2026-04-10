/**
 * Polling Constants
 *
 * Configuration for the polling-based change detection system.
 * Only tables in MONITORED_TABLES will be polled.
 * History tables should NOT be monitored - they are append-only audit logs.
 */

import { getSportAdapter } from '../adapters/index.js';

const adapter = getSportAdapter();

export const POLLING_CONSTANTS = {
    /** Interval between poll cycles in milliseconds */
    POLL_INTERVAL_MS: Number(process.env.POLL_INTERVAL_MS ?? '1000'),

    /** Maximum rows to fetch per table per poll cycle */
    POLL_BATCH_LIMIT: Number(process.env.POLL_BATCH_LIMIT ?? '500'),

    /** Concurrent row processors (aligned with DB concurrency) */
    POLL_CONCURRENCY: Number(process.env.POLL_CONCURRENCY ?? '40'),

    /** Max retries for transient processing errors */
    POLL_RETRY_MAX: Number(process.env.POLL_RETRY_MAX ?? '3'),

    /** Base delay for exponential backoff on retry (ms) */
    POLL_RETRY_BASE_MS: Number(process.env.POLL_RETRY_BASE_MS ?? '100'),

    /** Minutes of history to catch up on startup (0 = start from now) */
    POLL_CATCHUP_MINUTES: Number(process.env.POLL_CATCHUP_MINUTES ?? '0'),

    /** Tables to poll for changes */
    MONITORED_TABLES: adapter.polling.tables,
} as const;
