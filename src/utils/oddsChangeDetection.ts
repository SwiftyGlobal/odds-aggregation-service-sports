/**
 * Odds Change Detection Utility
 * Provides stable signature-based change detection that excludes metadata
 * from provider odds comparison to prevent history spam.
 * Only price-relevant fields are compared (decimal, fractional).
 */

/**
 * Build a stable signature from provider odds that only includes price-relevant fields.
 * Excludes metadata like last_changed_at, lastUpdated.
 * 
 * @param providerOdds - Provider odds object (can be JSON string, parsed object, or null)
 * @returns Stable JSON string signature with only price fields (decimal, fractional)
 */
export function buildProviderPricesSignature(providerOdds: any): string {
    if (!providerOdds) {
        return '{}';
    }

    // Parse if it's a string
    let parsed: Record<string | number, any>;
    try {
        parsed = typeof providerOdds === 'string' ? JSON.parse(providerOdds) : providerOdds;
    } catch {
        return '{}';
    }

    if (typeof parsed !== 'object' || parsed === null) {
        return '{}';
    }

    // Build sanitized object with only price fields
    const sanitized: Record<string, { decimal?: number; fractional?: string }> = {};

    for (const [providerId, data] of Object.entries(parsed)) {
        if (!data || typeof data !== 'object') {
            continue;
        }

        const priceData: { decimal?: number; fractional?: string } = {};

        // Handle different structures:
        // 1. oddsAggregationService: { fractional, decimal, last_changed_at }
        // 2. oddsProcessingService: { odds, displayOdds, lastUpdated }

        if (data.decimal !== undefined) {
            // Normalize decimal to number
            const dec = typeof data.decimal === 'string' ? parseFloat(data.decimal) : data.decimal;
            if (!isNaN(dec) && isFinite(dec)) {
                priceData.decimal = dec;
            }
        } else if (data.odds !== undefined) {
            // oddsProcessingService structure - extract decimal from odds field
            const oddsValue = data.odds;
            if (typeof oddsValue === 'number' && !isNaN(oddsValue) && isFinite(oddsValue)) {
                priceData.decimal = oddsValue;
            } else if (typeof oddsValue === 'string') {
                // Try to parse as decimal
                const parsedDecimal = parseFloat(oddsValue);
                if (!isNaN(parsedDecimal) && isFinite(parsedDecimal)) {
                    priceData.decimal = parsedDecimal;
                }
            }
        }

        // Extract fractional if available
        if (data.fractional && typeof data.fractional === 'string') {
            priceData.fractional = data.fractional;
        }

        // Only include if we have at least one price field
        if (priceData.decimal !== undefined || priceData.fractional !== undefined) {
            sanitized[String(providerId)] = priceData;
        }
    }

    // Sort by provider ID for consistent ordering
    const sortedKeys = Object.keys(sanitized).sort((a, b) => Number(a) - Number(b));
    const sorted: Record<string, { decimal?: number; fractional?: string }> = {};
    for (const key of sortedKeys) {
        const value = sanitized[key];
        if (value) {
            sorted[key] = value;
        }
    }

    return JSON.stringify(sorted);
}

/**
 * Detect the type of change between old and new provider odds.
 * 
 * @param oldProviderOdds - Previous provider odds (can be JSON string, parsed object, or null)
 * @param newProviderOdds - Current provider odds (can be JSON string, parsed object, or null)
 * @param oldProviderCount - Previous provider count
 * @param newProviderCount - Current provider count
 * @returns Change type: 'created', 'provider_added', 'provider_removed', 'price_change', or 'update'
 */
export function detectChangeType(
    oldProviderOdds: any,
    newProviderOdds: any,
    oldProviderCount: number,
    newProviderCount: number
): string {
    // If no previous state, it's a new record
    if (!oldProviderOdds || oldProviderCount === 0) {
        return 'created';
    }

    // Provider count changes
    if (newProviderCount > oldProviderCount) {
        return 'provider_added';
    }
    if (newProviderCount < oldProviderCount) {
        return 'provider_removed';
    }

    // Build signatures for comparison
    const oldSignature = buildProviderPricesSignature(oldProviderOdds);
    const newSignature = buildProviderPricesSignature(newProviderOdds);

    // If signatures differ, it's a price change (same providers, different prices)
    if (oldSignature !== newSignature) {
        return 'price_change';
    }

    // Fallback to generic update
    return 'update';
}
