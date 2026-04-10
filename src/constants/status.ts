/**
 * Status-related constants
 * Delegates to the active sport adapter for event status names
 */

import { getSportAdapter } from '../adapters/index.js';

export const EVENT_STATUS_IDS = getSportAdapter().eventStatus;
