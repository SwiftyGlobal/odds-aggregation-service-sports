/**
 * Pre Event Coverage Repository
 * Database operations for pre-event coverage computation
 */

import { Knex } from 'knex';
import { TABLES } from '../constants/tables.js';
import { COVERAGE_CONFIG } from '../constants/coverage.js';

export class PreEventCoverageRepository {
    /**
     * Compute all coverage arrays for a pre-event
     * 
     * @param preEventId - The pre-event ID
     * @param trx - Transaction (required)
     * @returns Coverage arrays and counts
     */
    static async computeCoverageArrays(
        preEventId: number,
        trx: Knex.Transaction
    ): Promise<{
        linkedProviderIds: number[];
        identityMatchedProviderIds: number[];
        eligibleOddsProviderIds: number[];
        fixedOddsAvailableProviderIds: number[];
    }> {
        // 1. Compute linked_provider_ids
        const linkedProviderRows = await trx(TABLES.PROVIDER_EVENTS)
            .where('pre_event_id', preEventId)
            .select('provider_id')
            .distinct();

        const linkedProviderIds = Array.from(
            new Set(linkedProviderRows.map(row => row.provider_id))
        ).sort((a, b) => a - b);

        // 2. Compute identity_matched_provider_ids
        const identityMatchedProviderIds: number[] = [];

        for (const providerId of linkedProviderIds) {
            // Get all provider events for this provider and pre-event
            const providerEvents = await trx(TABLES.PROVIDER_EVENTS)
                .where('pre_event_id', preEventId)
                .where('provider_id', providerId)
                .select('id');

            if (providerEvents.length === 0) {
                continue;
            }

            const providerEventIds = providerEvents.map(e => e.id);

            // Count mapped participants (pre_event_participant_id IS NOT NULL)
            const mappedCountResult = await trx(TABLES.PROVIDER_EVENT_PARTICIPANTS)
                .whereIn('provider_event_id', providerEventIds)
                .whereNotNull('pre_event_entry_id')
                .count('id as count')
                .first();

            const mappedCount = parseInt(mappedCountResult?.count as string, 10) || 0;

            if (mappedCount >= COVERAGE_CONFIG.MIN_MAPPED_PARTICIPANTS) {
                identityMatchedProviderIds.push(providerId);
            }
        }

        // Sort and ensure unique
        const sortedIdentityMatched = Array.from(
            new Set(identityMatchedProviderIds)
        ).sort((a, b) => a - b);

        // 3. Compute eligible_odds_provider_ids
        // Subset of identity_matched_provider_ids where ANY linked provider_event
        // has odds_available = true OR odds_available = false
        // (Essentially all identity_matched providers are eligible)
        const eligibleOddsProviderIds = [...sortedIdentityMatched];

        // 4. Compute fixed_odds_available_provider_ids
        // Subset of identity_matched_provider_ids where ANY linked provider_event
        // has odds_available = true
        const fixedOddsAvailableProviderIds: number[] = [];

        for (const providerId of sortedIdentityMatched) {
            // Check if any provider event has odds_available = true
            const hasOddsAvailable = await trx(TABLES.PROVIDER_EVENTS)
                .where('pre_event_id', preEventId)
                .where('provider_id', providerId)
                .where('odds_available', true)
                .first('id');

            if (hasOddsAvailable) {
                fixedOddsAvailableProviderIds.push(providerId);
            }
        }

        // Sort and ensure unique
        const sortedFixedOddsAvailable = Array.from(
            new Set(fixedOddsAvailableProviderIds)
        ).sort((a, b) => a - b);

        return {
            linkedProviderIds,
            identityMatchedProviderIds: sortedIdentityMatched,
            eligibleOddsProviderIds,
            fixedOddsAvailableProviderIds: sortedFixedOddsAvailable
        };
    }
}

