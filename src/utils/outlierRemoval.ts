/**
 * Outlier Removal Utility
 * Median-based outlier detection for odds aggregation
 */

export interface ProviderOddsCandidate {
    providerId: number;
    decimal: number;
}

export interface OutlierRemovalResult {
    included: ProviderOddsCandidate[];
    outliers: ProviderOddsCandidate[];
}

/**
 * Compute the median of an array of numbers
 */
function computeMedian(values: number[]): number {
    if (values.length === 0) return 0;

    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);

    if (sorted.length % 2 === 0) {
        return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
    }
    return sorted[mid] ?? 0;
}

/**
 * Remove outliers from provider odds candidates using median-based detection
 * 
 * Rules:
 * - If candidates.length < 3: no outlier removal
 * - Otherwise: mark as outlier if |x - median| / median > tolerancePct
 * - If all would be outliers: fall back to using all as included
 * 
 * @param candidates - Array of provider odds with decimal values
 * @param tolerancePct - Tolerance threshold (e.g., 0.15 for 15%)
 * @returns Object with included and outlier arrays
 */
export function removeOutliers(
    candidates: ProviderOddsCandidate[],
    tolerancePct: number
): OutlierRemovalResult {
    // Not enough candidates for outlier removal
    if (candidates.length < 3) {
        return {
            included: [...candidates],
            outliers: []
        };
    }

    const decimals = candidates.map(c => c.decimal);
    const median = computeMedian(decimals);

    // Edge case: median is 0 or very small
    if (median <= 0) {
        return {
            included: [...candidates],
            outliers: []
        };
    }

    const included: ProviderOddsCandidate[] = [];
    const outliers: ProviderOddsCandidate[] = [];

    for (const candidate of candidates) {
        const deviation = Math.abs(candidate.decimal - median) / median;

        if (deviation > tolerancePct) {
            outliers.push(candidate);
        } else {
            included.push(candidate);
        }
    }

    // Edge case: all candidates would be outliers - fall back to using all
    if (included.length === 0) {
        return {
            included: [...candidates],
            outliers: []
        };
    }

    return { included, outliers };
}

/**
 * Calculate the arithmetic mean of decimal values
 */
export function calculateMean(values: number[]): number | null {
    if (values.length === 0) return null;
    return values.reduce((sum, v) => sum + v, 0) / values.length;
}

