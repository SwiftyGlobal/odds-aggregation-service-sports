/**
 * Sports-related constants
 * Delegates to the active sport adapter
 */

import { getSportAdapter } from '../adapters/index.js';

const adapter = getSportAdapter();

export const SPORT_IDS = {
    [adapter.sport.name.toUpperCase().replace(/[\s-]/g, '_')]: adapter.sport.id,
    // Always export the current sport's ID as CURRENT_SPORT for generic use
    CURRENT_SPORT: adapter.sport.id
} as const;

export const SPORT_CODES = {
    [adapter.sport.name.toUpperCase().replace(/[\s-]/g, '_')]: adapter.sport.code,
    CURRENT_SPORT: adapter.sport.code
} as const;
