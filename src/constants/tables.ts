/**
 * Table Names Constants
 * Delegates to the active sport adapter for sport-specific table names
 */

import { getSportAdapter } from '../adapters/index.js';

export const TABLES = getSportAdapter().tables;
