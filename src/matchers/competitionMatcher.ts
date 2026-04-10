/**
 * Competition Matcher - Matches provider competitions to pre-competitions
 * Uses venue name similarity, country code, and date proximity for matching
 */

import { DatabaseService } from '../utils/database.js';
import { logger } from '../utils/logger.js';
import { StringSimilarity } from '../utils/stringSimilarity.js';
import { TABLES } from '../constants/tables.js';
import { getSportAdapter } from '../adapters/index.js';
import { PreCompetitionRepository } from '../repositories/preCompetitionRepository.js';

export interface CompetitionMatchResult {
    preCompetitionId: number;
    confidence: number;
    matchReason: string;
    isNew: boolean;
}

export class CompetitionMatcher {
    private static db = DatabaseService.getInstance();

    /**
     * Match a provider competition to existing pre-competition or create new one
     */
    static async matchOrCreateCompetition(providerCompetition: any): Promise<CompetitionMatchResult> {
        const competitionRefId = providerCompetition.competition_ref_id || providerCompetition.group_ref_id;
        const competitionName = providerCompetition.competition_name || providerCompetition.name;
        logger.debug('Matching competition', {
            providerId: providerCompetition.provider_id,
            competitionRefId,
            competitionName
        });

        try {
            // First, try to find existing match
            const match = await this.findCompetitionMatch(providerCompetition);

            if (match) {
                // Update provider competition with pre_competition_id
                await this.linkProviderToPreCompetition(providerCompetition.id, match.preCompetitionId);

                logger.info('Competition matched to existing pre-competition', {
                    providerCompetitionId: providerCompetition.id,
                    preCompetitionId: match.preCompetitionId,
                    confidence: match.confidence,
                    reason: match.matchReason
                });

                return {
                    preCompetitionId: match.preCompetitionId,
                    confidence: match.confidence,
                    matchReason: match.matchReason,
                    isNew: false
                };
            }

            // No match found, create new pre-competition
            const preCompetitionId = await this.createPreCompetition(providerCompetition);

            // Link provider competition to new pre-competition
            await this.linkProviderToPreCompetition(providerCompetition.id, preCompetitionId);

            logger.info('New pre-competition created', {
                providerCompetitionId: providerCompetition.id,
                preCompetitionId,
                competitionName: providerCompetition.competition_name || providerCompetition.name
            });

            return {
                preCompetitionId,
                confidence: 1.0,
                matchReason: 'New competition created',
                isNew: true
            };

        } catch (error) {
            logger.error('Failed to match or create competition', error as Error, {
                providerCompetitionId: providerCompetition.id,
                competitionName: providerCompetition.competition_name || providerCompetition.name
            });
            throw error;
        }
    }

    /**
     * Find existing pre-competition that matches provider competition
     */
    private static async findCompetitionMatch(providerCompetition: any): Promise<{
        preCompetitionId: number;
        confidence: number;
        matchReason: string;
    } | null> {
        const db = DatabaseService.getInstance();

        // Extract venue name from competition name (format: "Venue - Country (Date)")
        const providerName = providerCompetition.competition_name || providerCompetition.name || '';
        const venueName = this.extractVenueName(providerName);
        const countryCode = this.extractCountryCode(providerName);
        const competitionDate = this.extractCompetitionDate(providerName);

        logger.debug('Extracted competition details', {
            venueName,
            countryCode,
            competitionDate,
            originalName: providerName
        });

        // Get all pre-competitions for the same sport
        const preCompetitions = await db(TABLES.PRE_COMPETITIONS)
            .where('pre_sport_id', getSportAdapter().sport.id)
            .orderBy('created_at', 'desc');

        let bestMatch = null;
        let bestScore = 0;

        for (const preCompetition of preCompetitions) {
            const score = this.calculateCompetitionMatchScore(
                venueName,
                countryCode,
                competitionDate,
                preCompetition.name
            );

            if (score > bestScore && score >= 0.7) { // Minimum 70% match
                bestMatch = {
                    preCompetitionId: preCompetition.id,
                    confidence: score,
                    matchReason: this.generateMatchReason(venueName, countryCode, score)
                };
                bestScore = score;
            }
        }

        return bestMatch;
    }

    /**
     * Calculate match score between provider and pre-competition
     */
    private static calculateCompetitionMatchScore(
        venueName: string,
        countryCode: string,
        competitionDate: string,
        preCompetitionName: string
    ): number {
        let score = 0;
        let factors = 0;

        // Venue name similarity (primary factor - 60% weight)
        const venueSimilarity = StringSimilarity.calculateSimilarity(
            venueName.toLowerCase(),
            this.extractVenueName(preCompetitionName).toLowerCase()
        );
        score += venueSimilarity * 0.6;
        factors += 0.6;

        // Country code match (30% weight)
        const preCountryCode = this.extractCountryCode(preCompetitionName);
        const countryMatch = countryCode === preCountryCode ? 1 : 0;
        score += countryMatch * 0.3;
        factors += 0.3;

        // Date proximity (10% weight)
        const preDate = this.extractCompetitionDate(preCompetitionName);
        const dateScore = this.calculateDateProximity(competitionDate, preDate);
        score += dateScore * 0.1;
        factors += 0.1;

        return factors > 0 ? score / factors : 0;
    }

    /**
     * Extract venue name from competition name
     * Format: "Venue - Country (Date)" -> "Venue"
     */
    private static extractVenueName(competitionName: string): string {
        const parts = competitionName.split(' - ');
        return parts[0]?.trim() || competitionName;
    }

    /**
     * Extract country code from competition name
     * Format: "Venue - Country (Date)" -> "Country"
     */
    private static extractCountryCode(competitionName: string): string {
        const parts = competitionName.split(' - ');
        if (parts.length < 2) return '';

        const countryPart = parts[1]?.split(' (')[0];
        return countryPart?.trim() || '';
    }

    /**
     * Extract date from competition name
     * Format: "Venue - Country (Date)" -> "Date"
     */
    private static extractCompetitionDate(competitionName: string): string {
        const match = competitionName.match(/\(([^)]+)\)$/);
        return match?.[1] || '';
    }

    /**
     * Calculate date proximity score
     */
    private static calculateDateProximity(date1: string, date2: string): number {
        if (!date1 || !date2) return 0;

        try {
            const d1 = new Date(date1);
            const d2 = new Date(date2);
            const diffDays = Math.abs(d1.getTime() - d2.getTime()) / (1000 * 60 * 60 * 24);

            // Same day = 1.0, within 3 days = 0.8, within 7 days = 0.5, else 0
            if (diffDays === 0) return 1.0;
            if (diffDays <= 3) return 0.8;
            if (diffDays <= 7) return 0.5;
            return 0;
        } catch {
            return 0;
        }
    }

    /**
     * Generate human-readable match reason
     */
    private static generateMatchReason(venueName: string, countryCode: string, score: number): string {
        const reasons = [];

        if (score >= 0.9) reasons.push('excellent venue match');
        else if (score >= 0.8) reasons.push('good venue match');
        else if (score >= 0.7) reasons.push('fair venue match');

        if (countryCode) reasons.push(`country: ${countryCode}`);

        return reasons.join(', ');
    }

    /**
     * Create new pre-competition from provider competition
     */
    private static async createPreCompetition(providerCompetition: any): Promise<number> {
        const id = await PreCompetitionRepository.createOrUpdatePreCompetition({
            competition_name: providerCompetition.competition_name || providerCompetition.name,
            venue_name: providerCompetition.venue_name || '',
            country_code: providerCompetition.country_code ?? null,
            day: providerCompetition.day || providerCompetition.start_date || new Date().toISOString().split('T')[0],
        });

        logger.info('Pre-competition created', {
            preCompetitionId: id,
            competitionName: providerCompetition.competition_name || providerCompetition.name
        });

        return id;
    }

    /**
     * Link provider competition to pre-competition
     */
    private static async linkProviderToPreCompetition(
        providerCompetitionId: number,
        preCompetitionId: number
    ): Promise<void> {
        const db = DatabaseService.getInstance();

        await db(TABLES.PROVIDER_COMPETITIONS)
            .where('id', providerCompetitionId)
            .update({
                pre_event_group_id: preCompetitionId,
                updated_at: new Date()
            });

        logger.debug('Provider competition linked to pre-competition', {
            providerCompetitionId,
            preCompetitionId
        });
    }

    /**
     * Get competition matching statistics
     */
    static async getMatchingStats(): Promise<{
        totalProviderCompetitions: number;
        linkedCompetitions: number;
        unlinkedCompetitions: number;
        preCompetitions: number;
    }> {
        const db = DatabaseService.getInstance();

        const totalProviderCompetitions = await db(TABLES.PROVIDER_COMPETITIONS)
            .count('* as count')
            .first();

        const linkedCompetitions = await db(TABLES.PROVIDER_COMPETITIONS)
            .whereNotNull('pre_event_group_id')
            .count('* as count')
            .first();

        const unlinkedCompetitions = await db(TABLES.PROVIDER_COMPETITIONS)
            .whereNull('pre_event_group_id')
            .count('* as count')
            .first();

        const preCompetitions = await db(TABLES.PRE_COMPETITIONS)
            .count('* as count')
            .first();

        return {
            totalProviderCompetitions: parseInt(String(totalProviderCompetitions?.count || '0')),
            linkedCompetitions: parseInt(String(linkedCompetitions?.count || '0')),
            unlinkedCompetitions: parseInt(String(unlinkedCompetitions?.count || '0')),
            preCompetitions: parseInt(String(preCompetitions?.count || '0'))
        };
    }
}
