/**
 * Provider-related constants
 * Delegates to the active sport adapter for provider configuration
 */

import { getSportAdapter } from '../adapters/index.js';

const adapter = getSportAdapter();

// Build PROVIDER_IDS and PROVIDER_NAMES from adapter's providers list
const providerIds: Record<string, number> = {};
const providerNames: Record<string, string> = {};

for (const provider of adapter.providers) {
    const key = provider.name.toUpperCase().replace(/[^A-Z0-9]/g, '_');
    providerIds[key] = provider.id;
    providerNames[key] = provider.name;
}

export const PROVIDER_IDS = providerIds as Record<string, number>;
export const PROVIDER_NAMES = providerNames as Record<string, string>;
