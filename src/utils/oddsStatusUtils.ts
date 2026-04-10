/**
 * Odds Status Utilities
 * Determines odds status based on event timing, using the active sport adapter's config.
 *
 * For sports with boardingPriceThresholdMinutes > 0 (e.g., horse racing):
 *   Far from start → EARLY_PRICE, close to start → BOARDING_PRICE
 * For sports with boardingPriceThresholdMinutes = 0 (e.g., golf):
 *   Returns the first (default) status from the adapter.
 */

import { getSportAdapter } from '../adapters/index.js';

/**
 * Get the default odds status ID from the adapter (first defined status).
 */
function getDefaultStatusId(): number {
    return Object.values(getSportAdapter().oddsStatus.statuses)[0] ?? 1;
}

/**
 * Determine the current odds status based on event timing.
 *
 * @param eventStartTime - The scheduled start time of the event (Date or ISO string)
 * @returns The odds status ID
 */
export function determineOddsStatus(eventStartTime: Date | string): number {
    const { statuses, boardingPriceThresholdMinutes } = getSportAdapter().oddsStatus;

    // Sports without early/boarding price tiers — return default status
    if (boardingPriceThresholdMinutes <= 0 || !statuses['EARLY_PRICE'] || !statuses['BOARDING_PRICE']) {
        return getDefaultStatusId();
    }

    const startTime = eventStartTime instanceof Date ? eventStartTime : new Date(eventStartTime);
    const now = new Date();
    const minutesUntilStart = (startTime.getTime() - now.getTime()) / (1000 * 60);

    if (minutesUntilStart > boardingPriceThresholdMinutes) {
        return statuses['EARLY_PRICE'];
    }

    return statuses['BOARDING_PRICE'];
}

/**
 * Determine odds status based on when the odds changed (last_changed_at) vs event start time.
 * Used when providers disagree on odds_status_id.
 *
 * @param eventStartTime - The scheduled start time of the event (Date or ISO string)
 * @param lastChangedAt - When the odds were last changed (Date or ISO string)
 * @returns The odds status ID
 */
export function determineOddsStatusFromChangeTime(
    eventStartTime: Date | string,
    lastChangedAt: Date | string
): number {
    const { statuses, boardingPriceThresholdMinutes } = getSportAdapter().oddsStatus;

    // Sports without early/boarding price tiers — return default status
    if (boardingPriceThresholdMinutes <= 0 || !statuses['EARLY_PRICE'] || !statuses['BOARDING_PRICE']) {
        return getDefaultStatusId();
    }

    const startTime = eventStartTime instanceof Date ? eventStartTime : new Date(eventStartTime);
    const changeTime = lastChangedAt instanceof Date ? lastChangedAt : new Date(lastChangedAt);
    const minutesUntilStart = (startTime.getTime() - changeTime.getTime()) / (1000 * 60);

    if (minutesUntilStart > boardingPriceThresholdMinutes) {
        return statuses['EARLY_PRICE'];
    }

    return statuses['BOARDING_PRICE'];
}
