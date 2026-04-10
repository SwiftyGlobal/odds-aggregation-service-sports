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

        // 3. Compute eligible_odds_provider_ids (all identity-matched for now)
        const eligibleOddsProviderIds = [...sortedIdentityMatched];

        // 4. fixed_odds_available_provider_ids: identity-matched providers with at least one priced selection
        const fixedOddsAvailableProviderIds: number[] = [];

        for (const providerId of sortedIdentityMatched) {
            const hasPricedSelection = await trx(TABLES.PROVIDER_ODDS)
                .join(
                    TABLES.PROVIDER_MARKETS,
                    `${TABLES.PROVIDER_MARKETS}.id`,
                    `${TABLES.PROVIDER_ODDS}.provider_market_id`
                )
                .join(
                    TABLES.PROVIDER_EVENTS,
                    `${TABLES.PROVIDER_EVENTS}.id`,
                    `${TABLES.PROVIDER_MARKETS}.provider_event_id`
                )
                .where(`${TABLES.PROVIDER_EVENTS}.pre_event_id`, preEventId)
                .where(`${TABLES.PROVIDER_EVENTS}.provider_id`, providerId)
                .whereNotNull(`${TABLES.PROVIDER_ODDS}.price`)
                .first(`${TABLES.PROVIDER_ODDS}.id`);

            if (hasPricedSelection) {
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

