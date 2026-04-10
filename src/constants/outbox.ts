/**
 * Outbox event constants
 */

export const OUTBOX_EVENT_TYPES = {
    PRE_ODDS_DELTA: 'pre_odds.delta',
    PRE_EVENT_FULL: 'pre_event.full'
} as const;

export const OUTBOX_SCHEMA_VERSION = 1 as const;
