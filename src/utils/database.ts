/**
 * Backwards-compatible wrapper around the shared KnexClient in config.
 * All database wiring now lives in src/config/knex.ts.
 */
export { KnexClient as DatabaseService, db } from '../config/knex.js';
