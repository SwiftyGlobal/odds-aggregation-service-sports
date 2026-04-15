/**
 * Event group matcher — links provider groups to canonical `fs_pre_event_groups`.
 */

import { DatabaseService } from '../utils/database.js';
import { logger } from '../utils/logger.js';
import { StringSimilarity } from '../utils/stringSimilarity.js';
import { TABLES } from '../constants/tables.js';
import { getSportAdapter } from '../adapters/index.js';
import { PreEventGroupRepository } from '../repositories/preEventGroupRepository.js';

export interface EventGroupMatchResult {
    preEventGroupId: number;
    confidence: number;
    matchReason: string;
    isNew: boolean;
}

export class EventGroupMatcher {
    private static db = DatabaseService.getInstance();

    static async matchOrCreateEventGroup(providerGroup: any): Promise<EventGroupMatchResult> {
        const refId = providerGroup.competition_ref_id || providerGroup.group_ref_id;
        const name = providerGroup.competition_name || providerGroup.name;
        logger.debug('Matching event group', {
            providerId: providerGroup.provider_id,
            groupRefId: refId,
            name
        });

        try {
            const match = await this.findEventGroupMatch(providerGroup);

            if (match) {
                await this.linkProviderToPreEventGroup(providerGroup.id, match.preEventGroupId);

                logger.info('Event group matched to existing pre event group', {
                    providerEventGroupId: providerGroup.id,
                    preEventGroupId: match.preEventGroupId,
                    confidence: match.confidence,
                    reason: match.matchReason
                });

                return {
                    preEventGroupId: match.preEventGroupId,
                    confidence: match.confidence,
                    matchReason: match.matchReason,
                    isNew: false
                };
            }

            const preEventGroupId = await this.createPreEventGroup(providerGroup);

            await this.linkProviderToPreEventGroup(providerGroup.id, preEventGroupId);

            logger.info('New pre event group created', {
                providerEventGroupId: providerGroup.id,
                preEventGroupId,
                name: providerGroup.competition_name || providerGroup.name
            });

            return {
                preEventGroupId,
                confidence: 1.0,
                matchReason: 'New event group created',
                isNew: true
            };
        } catch (error) {
            logger.error('Failed to match or create event group', error as Error, {
                providerEventGroupId: providerGroup.id,
                name: providerGroup.competition_name || providerGroup.name
            });
            throw error;
        }
    }

    private static async findEventGroupMatch(providerGroup: any): Promise<{
        preEventGroupId: number;
        confidence: number;
        matchReason: string;
    } | null> {
        const providerName = providerGroup.competition_name || providerGroup.name || '';
        const venueName = this.extractVenueName(providerName);
        const countryCode = this.extractCountryCode(providerName);
        const groupDate = this.extractGroupDate(providerName);

        logger.debug('Extracted event group details', {
            venueName,
            countryCode,
            groupDate,
            originalName: providerName
        });

        const preGroups = await this.db(TABLES.PRE_EVENT_GROUPS)
            .where('pre_sport_id', getSportAdapter().sport.id)
            .orderBy('created_at', 'desc');

        let bestMatch = null;
        let bestScore = 0;

        for (const preGroup of preGroups) {
            const score = this.calculateMatchScore(
                venueName,
                countryCode,
                groupDate,
                preGroup.name
            );

            if (score > bestScore && score >= 0.7) {
                bestMatch = {
                    preEventGroupId: preGroup.id,
                    confidence: score,
                    matchReason: this.generateMatchReason(venueName, countryCode, score)
                };
                bestScore = score;
            }
        }

        return bestMatch;
    }

    private static calculateMatchScore(
        venueName: string,
        countryCode: string,
        groupDate: string,
        preGroupName: string
    ): number {
        let score = 0;
        let factors = 0;

        const venueSimilarity = StringSimilarity.calculateSimilarity(
            venueName.toLowerCase(),
            this.extractVenueName(preGroupName).toLowerCase()
        );
        score += venueSimilarity * 0.6;
        factors += 0.6;

        const preCountryCode = this.extractCountryCode(preGroupName);
        const countryMatch = countryCode === preCountryCode ? 1 : 0;
        score += countryMatch * 0.3;
        factors += 0.3;

        const preDate = this.extractGroupDate(preGroupName);
        const dateScore = this.calculateDateProximity(groupDate, preDate);
        score += dateScore * 0.1;
        factors += 0.1;

        return factors > 0 ? score / factors : 0;
    }

    private static extractVenueName(groupName: string): string {
        const parts = groupName.split(' - ');
        return parts[0]?.trim() || groupName;
    }

    private static extractCountryCode(groupName: string): string {
        const parts = groupName.split(' - ');
        if (parts.length < 2) return '';

        const countryPart = parts[1]?.split(' (')[0];
        return countryPart?.trim() || '';
    }

    private static extractGroupDate(groupName: string): string {
        const match = groupName.match(/\(([^)]+)\)$/);
        return match?.[1] || '';
    }

    private static calculateDateProximity(date1: string, date2: string): number {
        if (!date1 || !date2) return 0;

        try {
            const d1 = new Date(date1);
            const d2 = new Date(date2);
            const diffDays = Math.abs(d1.getTime() - d2.getTime()) / (1000 * 60 * 60 * 24);

            if (diffDays === 0) return 1.0;
            if (diffDays <= 3) return 0.8;
            if (diffDays <= 7) return 0.5;
            return 0;
        } catch {
            return 0;
        }
    }

    private static generateMatchReason(venueName: string, countryCode: string, score: number): string {
        const reasons = [];

        if (score >= 0.9) reasons.push('excellent venue match');
        else if (score >= 0.8) reasons.push('good venue match');
        else if (score >= 0.7) reasons.push('fair venue match');

        if (countryCode) reasons.push(`country: ${countryCode}`);

        return reasons.join(', ');
    }

    private static async createPreEventGroup(providerGroup: any): Promise<number> {
        const id = await PreEventGroupRepository.createOrUpdatePreEventGroup({
            competition_name: providerGroup.competition_name || providerGroup.name,
            venue_name: providerGroup.venue_name || '',
            country_code: providerGroup.country_code ?? null,
            day:
                providerGroup.day ||
                (providerGroup.start_time
                    ? new Date(providerGroup.start_time).toISOString().slice(0, 10)
                    : null) ||
                providerGroup.start_date ||
                new Date().toISOString().split('T')[0],
        });

        logger.info('Pre event group created', {
            preEventGroupId: id,
            name: providerGroup.competition_name || providerGroup.name
        });

        return id;
    }

    private static async linkProviderToPreEventGroup(
        providerEventGroupId: number,
        preEventGroupId: number
    ): Promise<void> {
        const db = DatabaseService.getInstance();

        await db(TABLES.PROVIDER_EVENT_GROUPS)
            .where('id', providerEventGroupId)
            .update({
                pre_event_group_id: preEventGroupId,
                updated_at: new Date()
            });

        logger.debug('Provider event group linked to pre event group', {
            providerEventGroupId,
            preEventGroupId
        });
    }

    static async getMatchingStats(): Promise<{
        totalProviderEventGroups: number;
        linkedEventGroups: number;
        unlinkedEventGroups: number;
        preEventGroups: number;
    }> {
        const db = DatabaseService.getInstance();

        const totalProviderEventGroups = await db(TABLES.PROVIDER_EVENT_GROUPS)
            .count('* as count')
            .first();

        const linkedEventGroups = await db(TABLES.PROVIDER_EVENT_GROUPS)
            .whereNotNull('pre_event_group_id')
            .count('* as count')
            .first();

        const unlinkedEventGroups = await db(TABLES.PROVIDER_EVENT_GROUPS)
            .whereNull('pre_event_group_id')
            .count('* as count')
            .first();

        const preEventGroups = await db(TABLES.PRE_EVENT_GROUPS)
            .count('* as count')
            .first();

        return {
            totalProviderEventGroups: parseInt(String(totalProviderEventGroups?.count || '0')),
            linkedEventGroups: parseInt(String(linkedEventGroups?.count || '0')),
            unlinkedEventGroups: parseInt(String(unlinkedEventGroups?.count || '0')),
            preEventGroups: parseInt(String(preEventGroups?.count || '0'))
        };
    }
}
