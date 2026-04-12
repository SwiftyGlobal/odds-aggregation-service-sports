/**
 * Competition Matching Service
 * Handles fuzzy matching of provider competitions to pre-competitions
 */

import { DatabaseService } from '../utils/database.js';
import { logger } from '../utils/logger.js';
import { StringSimilarity } from '../utils/stringSimilarity.js';
import { CONFIG } from '../config/index.js';
import { SPORT_IDS } from '../constants/sports.js';
import { DbConcurrencyManager } from '../utils/dbConcurrencyManager.js';
import { CompetitionRepository } from '../repositories/competitionRepository.js';
import { PreCompetitionRepository } from '../repositories/preCompetitionRepository.js';
import { VenueNameMapRepository } from '../repositories/venueNameMapRepository.js';
import { getSportAdapter } from '../adapters/index.js';

export class CompetitionMatchingService {
    private static db = DatabaseService.getInstance();

    /**
     * Process competition change
     * Checks if pre_competition_id is null and matches/creates if needed
     */
    static async processCompetitionChange(
        providerCompetitionId: number,
        lsn: string,
        trx?: any
    ): Promise<void> {
        const operationId = `competition-${providerCompetitionId}-${lsn}`;

        // If transaction is provided, use it directly (no concurrency control needed)
        if (trx) {
            return await this.executeCompetitionChange(providerCompetitionId, lsn, trx);
        }

        // Acquire DB slot for concurrency control
        await DbConcurrencyManager.acquireDbSlot(operationId);

        try {
            await DatabaseService.withTransaction(async (transaction) => {
                await this.executeCompetitionChange(providerCompetitionId, lsn, transaction);
            });
        } finally {
            DbConcurrencyManager.releaseDbSlot(operationId);
        }
    }

    /**
     * Execute competition change processing logic
     */
    private static async executeCompetitionChange(
        providerCompetitionId: number,
        lsn: string,
        transaction: any
    ): Promise<void> {
        try {
            // Load provider competition from database
            const providerCompetition = await CompetitionRepository.getProviderCompetition(
                providerCompetitionId,
                transaction
            );

            if (!providerCompetition) {
                logger.warn('Provider competition not found', { providerCompetitionId });
                return;
            }

            // Skip if already matched
            if (providerCompetition.pre_competition_id) {
                logger.debug('Competition already matched', {
                    providerCompetitionId,
                    preCompetitionId: providerCompetition.pre_competition_id
                });
                return;
            }

            logger.info('Processing competition change', {
                providerCompetitionId,
                competitionName: providerCompetition.competition_name,
                venueName: providerCompetition.venue_name,
                countryCode: providerCompetition.country_code,
                day: providerCompetition.day
            });

            // Find or create pre-competition
            const preCompetitionId = await this.findOrCreatePreCompetition(
                providerCompetition,
                transaction
            );

            // Update provider competition with pre_competition_id
            await CompetitionRepository.updatePreCompetitionId(
                providerCompetitionId,
                preCompetitionId,
                transaction
            );

            logger.info('Competition matched and linked', {
                providerCompetitionId,
                preCompetitionId,
                lsn
            });

        } catch (error) {
            logger.error('Error processing competition change', error as Error, {
                providerCompetitionId,
                lsn
            });
            throw error;
        }
    }

    /**
     * Find existing pre-competition or create new one
     * Public method for use by ensureService
     */
    static async findOrCreatePreCompetition(
        providerCompetition: any,
        trx: any
    ): Promise<number> {
        const adapter = getSportAdapter();
        const matchField = adapter.matching.competition.matchField;
        const venueName = providerCompetition.venue_name || '';
        const competitionName = providerCompetition.competition_name || '';
        const countryCode = providerCompetition.country_code || '';
        const day = this.extractDay(providerCompetition);

        // For venue-based sports (horse-racing), check venue name mapping
        let normalizedMatchValue: string;
        let venueMapping: any = null;

        if (matchField === 'venue_name') {
            venueMapping = await VenueNameMapRepository.getProviderMapping(
                venueName,
                providerCompetition.provider_id,
                countryCode,
                trx
            );
            normalizedMatchValue = venueMapping?.canonical_venue_name || venueName;
        } else {
            // For name-based sports (golf), use competition_name directly
            normalizedMatchValue = competitionName;
        }

        const skipDayFilter = adapter.matching.competition.skipDayFilterForCandidates === true;
        const lockKey = skipDayFilter
            ? `comp-${normalizedMatchValue.toLowerCase()}-${countryCode || 'null'}`
            : `comp-${normalizedMatchValue.toLowerCase()}-${day}-${countryCode || 'null'}`;
        const releaseCompetitionLock = await DbConcurrencyManager.acquirePreEventLock(lockKey);

        try {
            const candidates = skipDayFilter
                ? await PreCompetitionRepository.findCandidatesForCurrentSport(
                    countryCode,
                    adapter.matching.competition.requireCountryMatch,
                    trx
                )
                : await PreCompetitionRepository.findCandidatesByDay(
                    day,
                    countryCode,
                    adapter.matching.competition.requireCountryMatch,
                    trx
                );

            logger.debug('Found candidate pre-competitions', {
                count: candidates.length,
                day,
                countryCode,
                matchField,
                matchValue: normalizedMatchValue,
                viaMapping: !!venueMapping,
                skipDayFilterForCandidates: skipDayFilter,
            });

            // Try to find match using the sport's match field
            let bestMatch = null;
            let bestSimilarity = 0;

            for (const candidate of candidates) {
                const candidateValue = candidate[matchField] || '';

                // If we have a venue mapping, check for exact match first
                if (venueMapping && normalizedMatchValue.toLowerCase() === candidateValue.toLowerCase()) {
                    bestMatch = candidate;
                    bestSimilarity = 1.0;
                    break;
                }

                // Similarity matching
                const similarity = StringSimilarity.calculateSimilarity(
                    normalizedMatchValue.toLowerCase(),
                    candidateValue.toLowerCase()
                );

                if (similarity > bestSimilarity && similarity >= adapter.matching.competition.venueSimilarityThreshold) {
                    bestMatch = candidate;
                    bestSimilarity = similarity;
                }
            }

            if (bestMatch) {
                logger.info('Found matching pre-competition', {
                    preCompetitionId: bestMatch.id,
                    similarity: bestSimilarity,
                    matchField,
                    providerValue: normalizedMatchValue,
                    candidateValue: bestMatch[matchField],
                    viaMapping: !!venueMapping
                });

                // Enrich pre-competition if needed
                await this.enrichPreCompetition(bestMatch.id, providerCompetition, trx);

                return bestMatch.id;
            }

            // No match found, create new pre-competition
            const finalVenueName = matchField === 'venue_name'
                ? (normalizedMatchValue || venueName || 'Unknown Venue')
                : (venueName || null);

            logger.info('No match found, creating new pre-competition', {
                competitionName,
                venueName: finalVenueName,
                countryCode,
                day,
                matchField
            });

            const preCompetitionId = await PreCompetitionRepository.createOrUpdatePreCompetition(
                {
                    competition_name: competitionName,
                    venue_name: finalVenueName as string,
                    country_code: countryCode || null,
                    day: day
                },
                trx
            );

            return preCompetitionId;
        } finally {
            releaseCompetitionLock();
        }
    }

    /**
     * Enrich pre-competition with missing fields from provider
     */
    private static async enrichPreCompetition(
        preCompetitionId: number,
        providerCompetition: any,
        trx: any
    ): Promise<void> {
        const updates: any = {};

        // Get existing pre-competition
        const existing = await PreCompetitionRepository.getPreCompetition(preCompetitionId, trx);

        if (!existing) {
            return;
        }

        // Fill missing venue_name
        if (providerCompetition.venue_name && !existing.venue_name) {
            updates.venue_name = providerCompetition.venue_name;
        }

        // Fill missing country_code
        if (providerCompetition.country_code && !existing.country_code) {
            updates.country_code = providerCompetition.country_code;
        }

        if (Object.keys(updates).length > 0) {
            await PreCompetitionRepository.updatePreCompetition(preCompetitionId, updates, trx);

            logger.debug('Enriched pre-competition', {
                preCompetitionId,
                updates
            });
        }
    }

    /**
     * Extract day from provider competition in YYYY-MM-DD format
     */
    private static extractDay(providerCompetition: any): string {
        // Try day field first
        if (providerCompetition.day) {
            const dayValue = providerCompetition.day;
            let dateOnly: string;

            // Handle Date object (from database DATE type - most common case)
            if (dayValue instanceof Date) {
                dateOnly = dayValue.toISOString().split('T')[0] || '';
            } else if (typeof dayValue === 'string') {
                // Handle string format (from JSON or string representation)
                dateOnly = dayValue.split('T')[0] || '';
            } else {
                // Invalid type - skip
                return '';
            }

            if (dateOnly && /^\d{4}-\d{2}-\d{2}$/.test(dateOnly)) {
                return dateOnly;
            }
        }

        // Try competition_ref_id formats
        if (providerCompetition.competition_ref_id) {
            // Format: "Delta Downs_2025-11-13"
            const underscoreParts = providerCompetition.competition_ref_id.split('_');
            if (underscoreParts.length > 1) {
                const datePart = underscoreParts[underscoreParts.length - 1];
                if (/^\d{4}-\d{2}-\d{2}$/.test(datePart)) {
                    return datePart;
                }
            }

            // Format: "2025-10-28.AUS.hawkesbury"
            const dotParts = providerCompetition.competition_ref_id.split('.');
            if (dotParts.length > 0 && /^\d{4}-\d{2}-\d{2}$/.test(dotParts[0])) {
                return dotParts[0];
            }
        }

        // Fallback: current date
        logger.warn('Could not extract day from provider competition, using current date', {
            competitionRefId: providerCompetition.competition_ref_id,
            day: providerCompetition.day
        });
        const today = new Date();
        const year = today.getFullYear();
        const month = String(today.getMonth() + 1).padStart(2, '0');
        const day = String(today.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }

}
