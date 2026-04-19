/**
 * Outbox event constants
 *
 * Sport-prefixed event types so a single shared outbox table can serve multiple
 * sports running as independent ECS tasks. The publisher routes by prefix:
 *   `golf.pre_event.full`       -> topic fs_sports.golf.pre_event.full
 *   `basketball.pre_odds.delta` -> topic fs_sports.basketball.pre_odds.delta
 */

import { getSportAdapter } from '../adapters/index.js';

const sportSlug = getSportAdapter().sport.code.toLowerCase();

export const OUTBOX_EVENT_TYPES = {
    PRE_ODDS_DELTA: `${sportSlug}.pre_odds.delta`,
    PRE_EVENT_FULL: `${sportSlug}.pre_event.full`,
} as const;

export const OUTBOX_SCHEMA_VERSION = 2 as const;
