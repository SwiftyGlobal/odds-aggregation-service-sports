/**
 * Event matching service - event matching
 * Matches events across providers using multiple criteria
 */

import {
    MatchedEvent,
    ProviderEventMatch,
    EventMatchingCriteria,
    ProviderEvent,
    PreEvent
} from '../types/index.js';
import { StringSimilarity } from '../utils/stringSimilarity.js';
import { logger } from '../utils/logger.js';

export class EventMatcher {
    private criteria: EventMatchingCriteria;

    constructor(criteria: EventMatchingCriteria) {
        this.criteria = criteria;
    }

    /**
     * Match events across providers
     */
    async matchEvents(
        preEvents: PreEvent[],
        providerEvents: Map<number, ProviderEvent[]>
    ): Promise<MatchedEvent[]> {
        const matchedEvents: MatchedEvent[] = [];

        logger.matching('Starting event matching process', {
            preEventCount: preEvents.length,
            providerCount: providerEvents.size
        });

        for (const preEvent of preEvents) {
            const matches = await this.findEventMatches(preEvent, providerEvents);

            if (matches.length > 0) {
                const confidence = this.calculateOverallConfidence(matches);
                const matchReason = this.generateMatchReason(matches);

                matchedEvents.push({
                    preEventId: preEvent.id,
                    providerEvents: matches,
                    confidence,
                    matchReason
                });

                logger.matching('Event matched successfully', {
                    preEventId: preEvent.id,
                    eventName: preEvent.eventName,
                    matchCount: matches.length,
                    confidence
                });
            } else {
                logger.matching('No matches found for event', {
                    preEventId: preEvent.id,
                    eventName: preEvent.eventName
                });
            }
        }

        logger.matching('Event matching completed', {
            totalEvents: preEvents.length,
            matchedEvents: matchedEvents.length,
            matchRate: (matchedEvents.length / preEvents.length) * 100
        });

        return matchedEvents;
    }

    /**
     * Find matches for a specific pre-event
     */
    private async findEventMatches(
        preEvent: PreEvent,
        providerEvents: Map<number, ProviderEvent[]>
    ): Promise<ProviderEventMatch[]> {
        const matches: ProviderEventMatch[] = [];
        const timeWindowMinutes = this.criteria.timeWindowMinutes * 60 * 1000; // Convert to milliseconds

        for (const [providerId, events] of providerEvents) {
            for (const providerEvent of events) {
                const matchScore = this.calculateEventMatchScore(preEvent, providerEvent);

                if (matchScore >= this.criteria.nameSimilarity) {
                    const timeDiff = Math.abs(
                        preEvent.eventStartTime.getTime() - providerEvent.eventStartTime.getTime()
                    );

                    if (timeDiff <= timeWindowMinutes) {
                        const confidence = this.calculateEventConfidence(preEvent, providerEvent, matchScore);

                        matches.push({
                            providerId,
                            providerEventId: providerEvent.id,
                            eventRefId: providerEvent.eventRefId,
                            eventName: providerEvent.eventName,
                            startTime: providerEvent.eventStartTime,
                            confidence,
                            matchFields: this.getMatchFields(preEvent, providerEvent)
                        });
                    }
                }
            }
        }

        // Sort by confidence and return top matches
        return matches.sort((a, b) => b.confidence - a.confidence);
    }

    /**
     * Calculate match score between pre-event and provider event
     */
    private calculateEventMatchScore(preEvent: PreEvent, providerEvent: ProviderEvent): number {
        let score = 0;
        let factors = 0;

        // Name similarity (primary factor)
        const nameSimilarity = StringSimilarity.calculateSimilarity(
            preEvent.eventName,
            providerEvent.eventName
        );
        score += nameSimilarity * 0.6; // 60% weight
        factors += 0.6;

        // Time proximity
        const timeDiff = Math.abs(
            preEvent.eventStartTime.getTime() - providerEvent.eventStartTime.getTime()
        );
        const timeScore = Math.max(0, 1 - (timeDiff / (this.criteria.timeWindowMinutes * 60 * 1000)));
        score += timeScore * 0.3; // 30% weight
        factors += 0.3;

        // Event group match (if required)
        if (this.criteria.eventGroupMatch && preEvent.preEventGroupId && providerEvent.preEventGroupId) {
            const eventGroupMatch = preEvent.preEventGroupId === providerEvent.preEventGroupId ? 1 : 0;
            score += eventGroupMatch * 0.1; // 10% weight
            factors += 0.1;
        }

        return factors > 0 ? score / factors : 0;
    }

    /**
     * Calculate confidence for a match
     */
    private calculateEventConfidence(
        preEvent: PreEvent,
        providerEvent: ProviderEvent,
        baseScore: number
    ): number {
        let confidence = baseScore;

        // Boost confidence for exact name matches
        if (preEvent.eventName.toLowerCase() === providerEvent.eventName.toLowerCase()) {
            confidence += 0.1;
        }

        // Boost confidence for very close time matches
        const timeDiff = Math.abs(
            preEvent.eventStartTime.getTime() - providerEvent.eventStartTime.getTime()
        );
        if (timeDiff < 5 * 60 * 1000) { // Within 5 minutes
            confidence += 0.05;
        }

        // Boost confidence for same canonical event group
        if (preEvent.preEventGroupId === providerEvent.preEventGroupId) {
            confidence += 0.1;
        }

        return Math.min(1.0, confidence);
    }

    /**
     * Calculate overall confidence for multiple matches
     */
    private calculateOverallConfidence(matches: ProviderEventMatch[]): number {
        if (matches.length === 0) return 0;
        if (matches.length === 1) return matches[0]?.confidence || 0;

        // Weight by confidence and provider priority
        const weightedSum = matches.reduce((sum, match) => {
            const weight = 1 / (matches.indexOf(match) + 1); // Higher weight for better matches
            return sum + (match.confidence * weight);
        }, 0);

        const totalWeight = matches.reduce((sum, _, index) => sum + (1 / (index + 1)), 0);

        return totalWeight > 0 ? weightedSum / totalWeight : 0;
    }

    /**
     * Generate human-readable match reason
     */
    private generateMatchReason(matches: ProviderEventMatch[]): string {
        const reasons: string[] = [];

        if (matches.length === 1) {
            const match = matches[0];
            if (match) {
                reasons.push(`Single match with ${match.confidence.toFixed(2)} confidence`);
            }
        } else {
            reasons.push(`${matches.length} provider matches`);
        }

        const highConfidenceMatches = matches.filter(m => m.confidence >= 0.9);
        if (highConfidenceMatches.length > 0) {
            reasons.push(`${highConfidenceMatches.length} high-confidence matches`);
        }

        return reasons.join(', ');
    }

    /**
     * Get fields that contributed to the match
     */
    private getMatchFields(preEvent: PreEvent, providerEvent: ProviderEvent): string[] {
        const fields: string[] = [];

        if (StringSimilarity.isLikelyMatch(preEvent.eventName, providerEvent.eventName, 0.8)) {
            fields.push('name');
        }

        const timeDiff = Math.abs(
            preEvent.eventStartTime.getTime() - providerEvent.eventStartTime.getTime()
        );
        if (timeDiff < this.criteria.timeWindowMinutes * 60 * 1000) {
            fields.push('time');
        }

        if (preEvent.preEventGroupId === providerEvent.preEventGroupId) {
            fields.push('event_group');
        }

        return fields;
    }

    /**
     * Validate match quality
     */
    static validateMatch(match: MatchedEvent): boolean {
        if (match.confidence < 0.7) return false;
        if (match.providerEvents.length === 0) return false;

        // Check for at least one high-confidence match
        const hasHighConfidence = match.providerEvents.some(pe => pe.confidence >= 0.8);
        if (!hasHighConfidence) return false;

        return true;
    }

    /**
     * Get match statistics
     */
    static getMatchStatistics(matches: MatchedEvent[]): {
        totalMatches: number;
        averageConfidence: number;
        highConfidenceMatches: number;
        providerDistribution: Record<number, number>;
    } {
        const totalMatches = matches.length;
        const averageConfidence = matches.length > 0
            ? matches.reduce((sum, match) => sum + match.confidence, 0) / matches.length
            : 0;
        const highConfidenceMatches = matches.filter(m => m.confidence >= 0.8).length;

        const providerDistribution: Record<number, number> = {};
        matches.forEach(match => {
            match.providerEvents.forEach(pe => {
                providerDistribution[pe.providerId] = (providerDistribution[pe.providerId] || 0) + 1;
            });
        });

        return {
            totalMatches,
            averageConfidence,
            highConfidenceMatches,
            providerDistribution
        };
    }
}
