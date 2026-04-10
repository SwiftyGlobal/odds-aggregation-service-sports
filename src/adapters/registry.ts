import { golfAdapter } from './golf/index.js';
import type { AdapterRegistry, SportAdapter } from './types.js';

const SPORT_ADAPTER = process.env.SPORT_ADAPTER;

const ADAPTERS: AdapterRegistry = {
    golf: golfAdapter,
};

let _adapter: SportAdapter | null = null;

export function getSportAdapter(): SportAdapter {
    if (!_adapter) {
        if (!SPORT_ADAPTER) {
            throw new Error('SPORT_ADAPTER environment variable is not set.');
        }
        const selected = ADAPTERS[SPORT_ADAPTER];
        if (!selected) {
            const validValues = Object.keys(ADAPTERS).join(', ');
            throw new Error(
                `Unknown SPORT_ADAPTER: "${SPORT_ADAPTER}". ` +
                `Valid values: ${validValues}.`
            );
        }
        _adapter = selected;
        console.log(`[Adapter] Loaded sport adapter: ${_adapter.sport.name} (${SPORT_ADAPTER})`);
    }
    return _adapter;
}

export function getRegisteredAdapters(): string[] {
    return Object.keys(ADAPTERS);
}
