/**
 * Configuration for the odds aggregation service
 * Uses the active sport adapter for provider and matching configuration
 */

import { AggregationConfig } from '../types/index.js';
import { getSportAdapter } from '../adapters/index.js';

const adapter = getSportAdapter();

export const CONFIG: AggregationConfig = {
    providers: adapter.providers,

    eventGroupMatching: adapter.matching.eventGroup,
    eventMatching: adapter.matching.event,
    participantMatching: adapter.matching.participant,

    oddsCalculation: {
        averageMethod: 'arithmetic', // Arithmetic mean for average odds
        minProviders: 1, // Minimum 1 provider required
        maxAgeSeconds: 86400 // Freshness window for provider odds (24 hours)
    },

    syncInterval: 5, // 5 minutes sync interval
    batchSize: 100, // Process 100 events per batch
    concurrency: 10 // 10 concurrent operations
};

export const DATABASE_CONFIG = {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432'),
    database: process.env.DB_NAME || 'feed_sports_db',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'password',
    ssl: process.env.PG_SSL === 'true' ? { rejectUnauthorized: false } : false,
    pool: {
        min: parseInt(process.env.PG_POOL_MIN || '0'),
        max: parseInt(process.env.PG_POOL_MAX || '20')
    }
};

// Constants moved to src/constants/ - import from there
// Re-export for backward compatibility
export { PROVIDER_IDS, EVENT_STATUS_IDS, SPORT_IDS } from '../constants/index.js';

export const LOG_LEVELS = {
    ERROR: 0,
    WARN: 1,
    INFO: 2,
    DEBUG: 3
} as const;

export const LOG_CONFIG = {
    level: parseInt(process.env.LOG_LEVEL || '2'),
    format: process.env.LOG_FORMAT || 'text',
    enableConsole: process.env.LOG_CONSOLE !== 'false'
} as const;

/**
 * Odds margin configuration for display odds calculation
 */
export const ODDS_MARGIN_CONFIG = {
    /** Margin percentage to apply (reduces odds). Default 5% */
    marginPct: parseFloat(process.env.ODDS_MARGIN_PCT ?? '0.05'),
    /** Tolerance for median-based outlier detection. Default 15% */
    outlierTolerancePct: parseFloat(process.env.ODDS_OUTLIER_TOLERANCE_PCT ?? '0.15')
} as const;
