/**
 * Venue Name Map Repository
 * Database operations for venue name mappings
 */

import { DatabaseService } from '../utils/database.js';
import { Knex } from 'knex';
import { TABLES } from '../constants/tables.js';

export class VenueNameMapRepository {
    private static db = DatabaseService.getInstance();

    /**
     * Get venue name mapping for a specific provider
     * Returns canonical venue name if mapping exists
     * 
     * @param providerVenueName - The provider's venue name
     * @param providerId - The provider ID
     * @param countryCode - Optional country code filter
     * @param trx - Optional transaction
     * @returns Mapping with canonical_venue_name or null
     */
    static async getProviderMapping(
        providerVenueName: string,
        providerId: number,
        countryCode: string | null,
        trx?: Knex.Transaction
    ): Promise<{ canonical_venue_name: string } | null> {
        if (!providerVenueName) return null;
        if (!TABLES.VENUE_NAME_MAP) return null;

        const db = trx || this.db;

        let query = db(TABLES.VENUE_NAME_MAP)
            .where('provider_id', providerId)
            .where('provider_venue_name', providerVenueName)
            .where('is_active', true);

        if (countryCode) {
            query = query.where(function (this: any) {
                this.where('country_code', countryCode)
                    .orWhereNull('country_code');
            });
        }

        const mapping = await query.first();
        return mapping || null;
    }

    /**
     * Get venue name mapping for any provider
     * Used when comparing pre-events that might have been created by different providers
     * 
     * @param providerVenueName - The provider's venue name
     * @param trx - Optional transaction
     * @returns Mapping with canonical_venue_name or null
     */
    static async getAnyMapping(
        providerVenueName: string,
        trx?: Knex.Transaction
    ): Promise<{ canonical_venue_name: string } | null> {
        if (!providerVenueName) return null;
        if (!TABLES.VENUE_NAME_MAP) return null;

        const db = trx || this.db;

        const mapping = await db(TABLES.VENUE_NAME_MAP)
            .where('provider_venue_name', providerVenueName)
            .where('is_active', true)
            .first();

        return mapping || null;
    }
}

