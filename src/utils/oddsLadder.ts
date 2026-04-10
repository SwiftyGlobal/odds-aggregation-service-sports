/**
 * Odds Ladder Utility
 * Handles snapping decimal odds to the standard betting ladder
 */

import oddsLadderData from '../data/oddsLadder.json' with { type: 'json' };

interface LadderEntry {
    key: number;
    display: Array<{ key: string; value: string }>;
}

interface SnappedOdds {
    decimal: number;
    fractional: string | null;
}

/** Sorted ladder keys (decimal values) for binary search */
const ladderKeys: number[] = (oddsLadderData as LadderEntry[])
    .map(entry => entry.key)
    .sort((a, b) => a - b);

/** Map from decimal key to full ladder entry for O(1) lookup */
const ladderMap = new Map<number, LadderEntry>(
    (oddsLadderData as LadderEntry[]).map(entry => [entry.key, entry])
);

/** Minimum and maximum ladder values */
const MIN_LADDER = ladderKeys[0] ?? 1.01;
const MAX_LADDER = ladderKeys[ladderKeys.length - 1] ?? 1001;

/**
 * Binary search to find the largest ladder value <= target
 * Returns the index in ladderKeys
 */
function binarySearchFloor(target: number): number {
    let left = 0;
    let right = ladderKeys.length - 1;
    let result = 0;

    while (left <= right) {
        const mid = Math.floor((left + right) / 2);
        const midVal = ladderKeys[mid];

        if (midVal === undefined) break;

        if (midVal <= target) {
            result = mid;
            left = mid + 1;
        } else {
            right = mid - 1;
        }
    }

    return result;
}

/**
 * Snap a decimal odds value DOWN to the nearest ladder value
 * @param decimal - The decimal odds to snap
 * @returns Snapped decimal and fractional representation
 */
export function snapToLadder(decimal: number): SnappedOdds {
    if (!isFinite(decimal) || decimal < MIN_LADDER) {
        return {
            decimal: MIN_LADDER,
            fractional: getFractionalFromLadder(MIN_LADDER)
        };
    }

    if (decimal > MAX_LADDER) {
        return {
            decimal: MAX_LADDER,
            fractional: getFractionalFromLadder(MAX_LADDER)
        };
    }

    const index = binarySearchFloor(decimal);
    const snappedDecimal = ladderKeys[index] ?? MIN_LADDER;

    return {
        decimal: snappedDecimal,
        fractional: getFractionalFromLadder(snappedDecimal)
    };
}

/**
 * Get the fractional representation from the ladder for a given decimal
 */
function getFractionalFromLadder(decimal: number): string | null {
    const entry = ladderMap.get(decimal);
    if (!entry) return null;

    const fracDisplay = entry.display.find(d => d.key === 'fra');
    return fracDisplay?.value ?? null;
}

/**
 * Get a full ladder entry by decimal value
 */
export function getLadderEntry(decimal: number): LadderEntry | undefined {
    return ladderMap.get(decimal);
}

/**
 * Check if a decimal value exists exactly on the ladder
 */
export function isOnLadder(decimal: number): boolean {
    return ladderMap.has(decimal);
}

/**
 * Get all ladder keys (sorted ascending)
 */
export function getLadderKeys(): readonly number[] {
    return ladderKeys;
}

