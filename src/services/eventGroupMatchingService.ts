/**
 * Event group matching — links provider `fs_provider_event_groups` rows to `fs_pre_event_groups`.
 */

import { DatabaseService } from '../utils/database.js';
import { logger } from '../utils/logger.js';
import { StringSimilarity } from '../utils/stringSimilarity.js';
import { SPORT_IDS } from '../constants/sports.js';
import { DbConcurrencyManager } from '../utils/dbConcurrencyManager.js';
import { ProviderEventGroupRepository } from '../repositories/providerEventGroupRepository.js';
import { PreEventGroupRepository } from '../repositories/preEventGroupRepository.js';
import { VenueNameMapRepository } from '../repositories/venueNameMapRepository.js';
import { getSportAdapter } from '../adapters/index.js';

export class EventGroupMatchingService {
    /**
     * Process a provider event group change when `pre_event_group_id` is unset.
     */
    static async processProviderEventGroupChange(
        providerEventGroupId: number,
        lsn: string,
        trx?: any
    ): Promise<void> {
        const operationId = `event-group-${providerEventGroupId}-${lsn}`;

        if (trx) {
            return await this.executeProviderEventGroupChange(providerEventGroupId, lsn, trx);
        }

        await DbConcurrencyManager.acquireDbSlot(operationId);

        try {
            await DatabaseService.withTransaction(async (transaction) => {
                await this.executeProviderEventGroupChange(providerEventGroupId, lsn, transaction);
            });
        } finally {
            DbConcurrencyManager.releaseDbSlot(operationId);
        }
    }

    private static async executeProviderEventGroupChange(
        providerEventGroupId: number,
        lsn: string,
        transaction: any
    ): Promise<void> {
        try {
            const providerGroup = await ProviderEventGroupRepository.getProviderEventGroup(
                providerEventGroupId,
                transaction
            );

            if (!providerGroup) {
                logger.warn('Provider event group not found', { providerEventGroupId });
                return;
            }

            const linkedId = providerGroup.pre_event_group_id ?? providerGroup.pre_competition_id;
            if (linkedId) {
                logger.debug('Event group already matched', {
                    providerEventGroupId,
                    preEventGroupId: linkedId
                });
                return;
            }

            logger.info('Processing provider event group change', {
                providerEventGroupId,
                name: providerGroup.competition_name,
                venueName: providerGroup.venue_name,
                countryCode: providerGroup.country_code,
                day: providerGroup.day
            });

            const preEventGroupId = await this.findOrCreatePreEventGroup(providerGroup, transaction);

            await ProviderEventGroupRepository.updatePreEventGroupId(
                providerEventGroupId,
                preEventGroupId,
                transaction
            );

            logger.info('Event group matched and linked', {
                providerEventGroupId,
                preEventGroupId,
                lsn
            });
        } catch (error) {
            logger.error('Error processing provider event group change', error as Error, {
                providerEventGroupId,
                lsn
            });
            throw error;
        }
    }

    static async findOrCreatePreEventGroup(providerGroup: any, trx: any): Promise<number> {
        const adapter = getSportAdapter();
        const matchField = adapter.matching.eventGroup.matchField;
        const venueName = providerGroup.venue_name || '';
        const groupName = providerGroup.competition_name || '';
        const countryCode = providerGroup.country_code || '';
        const day = this.extractDay(providerGroup);

        let normalizedMatchValue: string;
        let venueMapping: any = null;

        if (matchField === 'venue_name') {
            venueMapping = await VenueNameMapRepository.getProviderMapping(
                venueName,
                providerGroup.provider_id,
                countryCode,
                trx
            );
            normalizedMatchValue = venueMapping?.canonical_venue_name || venueName;
        } else {
            normalizedMatchValue = groupName;
        }

        const skipDayFilter = adapter.matching.eventGroup.skipDayFilterForCandidates === true;
        const lockKey = skipDayFilter
            ? `peg-${normalizedMatchValue.toLowerCase()}-${countryCode || 'null'}`
            : `peg-${normalizedMatchValue.toLowerCase()}-${day}-${countryCode || 'null'}`;
        const releaseLock = await DbConcurrencyManager.acquirePreEventLock(lockKey);

        try {
            const candidates = skipDayFilter
                ? await PreEventGroupRepository.findCandidatesForCurrentSport(
                    countryCode,
                    adapter.matching.eventGroup.requireCountryMatch,
                    trx
                )
                : await PreEventGroupRepository.findCandidatesByDay(
                    day,
                    countryCode,
                    adapter.matching.eventGroup.requireCountryMatch,
                    trx
                );

            logger.debug('Found candidate pre event groups', {
                count: candidates.length,
                day,
                countryCode,
                matchField,
                matchValue: normalizedMatchValue,
                viaMapping: !!venueMapping,
                skipDayFilterForCandidates: skipDayFilter,
            });

            let bestMatch = null;
            let bestSimilarity = 0;

            for (const candidate of candidates) {
                const candidateValue = candidate[matchField] || '';

                if (venueMapping && normalizedMatchValue.toLowerCase() === candidateValue.toLowerCase()) {
                    bestMatch = candidate;
                    bestSimilarity = 1.0;
                    break;
                }

                const similarity = StringSimilarity.calculateSimilarity(
                    normalizedMatchValue.toLowerCase(),
                    candidateValue.toLowerCase()
                );

                if (similarity > bestSimilarity && similarity >= adapter.matching.eventGroup.venueSimilarityThreshold) {
                    bestMatch = candidate;
                    bestSimilarity = similarity;
                }
            }

            if (bestMatch) {
                logger.info('Found matching pre event group', {
                    preEventGroupId: bestMatch.id,
                    similarity: bestSimilarity,
                    matchField,
                    providerValue: normalizedMatchValue,
                    candidateValue: bestMatch[matchField],
                    viaMapping: !!venueMapping
                });

                await this.enrichPreEventGroup(bestMatch.id, providerGroup, trx);

                return bestMatch.id;
            }

            const finalVenueName = matchField === 'venue_name'
                ? (normalizedMatchValue || venueName || 'Unknown Venue')
                : (venueName || null);

            logger.info('No match found, creating new pre event group', {
                groupName,
                venueName: finalVenueName,
                countryCode,
                day,
                matchField
            });

            const preEventGroupId = await PreEventGroupRepository.createOrUpdatePreEventGroup(
                {
                    competition_name: groupName,
                    venue_name: finalVenueName as string,
                    country_code: countryCode || null,
                    day: day
                },
                trx
            );

            return preEventGroupId;
        } finally {
            releaseLock();
        }
    }

    private static async enrichPreEventGroup(
        preEventGroupId: number,
        providerGroup: any,
        trx: any
    ): Promise<void> {
        const updates: { venue_name?: string; country_code?: string } = {};

        const existing = await PreEventGroupRepository.getPreEventGroup(preEventGroupId, trx);

        if (!existing) {
            return;
        }

        if (providerGroup.venue_name && !existing.venue_name) {
            updates.venue_name = providerGroup.venue_name;
        }

        if (providerGroup.country_code && !existing.country_code) {
            updates.country_code = providerGroup.country_code;
        }

        if (Object.keys(updates).length > 0) {
            await PreEventGroupRepository.updatePreEventGroup(preEventGroupId, updates, trx);

            logger.debug('Enriched pre event group', {
                preEventGroupId,
                updates
            });
        }
    }

    private static extractDay(providerGroup: any): string {
        if (providerGroup.day) {
            const dayValue = providerGroup.day;
            let dateOnly: string;

            if (dayValue instanceof Date) {
                dateOnly = dayValue.toISOString().split('T')[0] || '';
            } else if (typeof dayValue === 'string') {
                dateOnly = dayValue.split('T')[0] || '';
            } else {
                return '';
            }

            if (dateOnly && /^\d{4}-\d{2}-\d{2}$/.test(dateOnly)) {
                return dateOnly;
            }
        }

        const refId = providerGroup.competition_ref_id ?? providerGroup.group_ref_id;
        if (refId) {
            const underscoreParts = String(refId).split('_');
            if (underscoreParts.length > 1) {
                const datePart = underscoreParts[underscoreParts.length - 1] ?? '';
                if (/^\d{4}-\d{2}-\d{2}$/.test(datePart)) {
                    return datePart;
                }
            }

            const dotParts = String(refId).split('.');
            const firstDot = dotParts[0] ?? '';
            if (dotParts.length > 0 && /^\d{4}-\d{2}-\d{2}$/.test(firstDot)) {
                return firstDot;
            }
        }

        logger.warn('Could not extract day from provider event group, using current date', {
            groupRefId: refId,
            day: providerGroup.day
        });
        const today = new Date();
        const year = today.getFullYear();
        const month = String(today.getMonth() + 1).padStart(2, '0');
        const d = String(today.getDate()).padStart(2, '0');
        return `${year}-${month}-${d}`;
    }
}
