/**
 * Event Matching Service
 * Handles fuzzy matching of provider events to pre-events
 */

import { DatabaseService } from '../utils/database.js';
import { logger } from '../utils/logger.js';
import { StringSimilarity } from '../utils/stringSimilarity.js';
import { CONFIG } from '../config/index.js';
import { EVENT_STATUS_IDS } from '../constants/status.js';
import { EventRepository } from '../repositories/eventRepository.js';
import { CompetitionRepository } from '../repositories/competitionRepository.js';
import { PreEventRepository } from '../repositories/preEventRepository.js';
import { VenueNameMapRepository } from '../repositories/venueNameMapRepository.js';
import { EnsureService } from './ensureService.js';
import { DbConcurrencyManager } from '../utils/dbConcurrencyManager.js';
import { PreEventCoverageService } from './preEventCoverageService.js';
import { getSportAdapter } from '../adapters/index.js';

export class EventMatchingService {
    private static db = DatabaseService.getInstance();

    /**
     * Process event change
     * Checks if pre_event_id is null and matches/creates if needed
     */
    static async processEventChange(
        providerEventId: number,
        lsn: string,
        trx?: any
    ): Promise<void> {
        const operationId = `event-${providerEventId}-${lsn}`;

        // If transaction is provided, use it directly (no concurrency control needed)
        if (trx) {
            return await this.executeEventChange(providerEventId, lsn, trx);
        }

        // Acquire DB slot for concurrency control
        await DbConcurrencyManager.acquireDbSlot(operationId);

        try {
            await DatabaseService.withRetryableTransaction(async (transaction) => {
                await this.executeEventChange(providerEventId, lsn, transaction);
            });
        } finally {
            DbConcurrencyManager.releaseDbSlot(operationId);
        }
    }

    /**
     * Execute event change processing logic
     */
    private static async executeEventChange(
        providerEventId: number,
        lsn: string,
        transaction: any
    ): Promise<void> {
        try {
            // Load provider event from database
            const providerEvent = await EventRepository.getProviderEvent(
                providerEventId,
                transaction
            );

            if (!providerEvent) {
                logger.warn('Provider event not found', { providerEventId });
                return;
            }

            // If already matched, update coverage and return (coverage may have changed)
            if (providerEvent.pre_event_id) {
                logger.debug('Event already matched, updating coverage', {
                    providerEventId,
                    preEventId: providerEvent.pre_event_id
                });
                await PreEventCoverageService.updatePreEventCoverage(providerEvent.pre_event_id, transaction);
                return;
            }

            logger.info('Processing event change', {
                providerEventId,
                eventName: providerEvent.name,
                eventStartTime: providerEvent.start_time,
                providerCompetitionId: providerEvent.provider_competition_id
            });

            // Check if competition is linked (dependency check)
            if (!providerEvent.provider_competition_id) {
                logger.warn('Event has no provider_competition_id, cannot process', { providerEventId });
                return;
            }

            // Ensure competition is matched (on-the-fly matching)
            const preCompetitionId = await EnsureService.ensurePreCompetitionFromProvider(
                providerEvent.provider_competition_id,
                transaction
            );

            // Serialize by pre_event key to prevent deadlocks when multiple providers
            // try to create/update the same pre_event (same competition + start time)
            // Normalize timestamp to time window to ensure events within the window use the same lock key
            const eventStartTime = new Date(providerEvent.start_time);
            const timeWindowMs = CONFIG.eventMatching.timeWindowMinutes * 60 * 1000;
            // Round down to nearest time window boundary to ensure events within the window use the same key
            const normalizedTime = Math.floor(eventStartTime.getTime() / timeWindowMs) * timeWindowMs;
            const preEventLockKey = `pre-${preCompetitionId}-${normalizedTime}`;

            // Note: We're already in a transaction, but we need application-level serialization
            // to prevent concurrent pre_event creation/updates from different provider events
            const releasePreEventLock = await DbConcurrencyManager.acquirePreEventLock(preEventLockKey);

            try {
                // Find or create pre-event
                const preEventId = await this.findOrCreatePreEvent(
                    providerEvent,
                    preCompetitionId,
                    transaction
                );

                // Update provider event with pre_event_id
                await EventRepository.updatePreEventId(
                    providerEventId,
                    preEventId,
                    transaction
                );

                logger.info('Event matched and linked', {
                    providerEventId,
                    preEventId,
                    preCompetitionId: preCompetitionId,
                    lsn
                });

                // Update pre-event coverage tracking
                await PreEventCoverageService.updatePreEventCoverage(preEventId, transaction);
                return;
            } finally {
                releasePreEventLock();
            }

        } catch (error) {
            logger.error('Error processing event change', error as Error, {
                providerEventId,
                lsn
            });
            throw error;
        }
    }

    /**
     * Find existing pre-event or create new one
     * Public method for use by ensureService
     */
    static async findOrCreatePreEvent(
        providerEvent: any,
        preCompetitionId: number,
        trx: any
    ): Promise<number> {
        const eventName = providerEvent.name || '';
        const eventStartTime = new Date(providerEvent.start_time);
        const timeWindowMs = CONFIG.eventMatching.timeWindowMinutes * 60 * 1000;
        const minTime = new Date(eventStartTime.getTime() - timeWindowMs);
        const maxTime = new Date(eventStartTime.getTime() + timeWindowMs);

        // Get provider competition to access provider_id and country_code for venue mapping
        const providerCompetition = providerEvent.provider_competition_id
            ? await CompetitionRepository.getProviderCompetition(providerEvent.provider_competition_id, trx)
            : null;

        // Normalize event name by replacing venue name with canonical name if mapping exists
        const normalizedEventName = await this.normalizeEventName(
            eventName,
            providerCompetition?.provider_id,
            providerCompetition?.country_code,
            trx
        );

        // Query existing pre-events for same competition and time window
        const candidates = await PreEventRepository.findCandidateEvents(
            preCompetitionId,
            minTime,
            maxTime,
            trx
        );

        logger.debug('Found candidate pre-events', {
            count: candidates.length,
            preCompetitionId,
            timeWindow: `${CONFIG.eventMatching.timeWindowMinutes} minutes`,
            originalEventName: eventName,
            normalizedEventName: normalizedEventName
        });

        // Try to find match by event name similarity
        let bestMatch = null;
        let bestSimilarity = 0;

        for (const candidate of candidates) {
            // Normalize candidate event name as well
            const normalizedCandidateName = await this.normalizeEventName(
                candidate.name,
                null, // We don't know the provider for pre-events, so try all mappings
                providerCompetition?.country_code,
                trx
            );

            const similarity = StringSimilarity.calculateSimilarity(
                normalizedEventName.toLowerCase(),
                normalizedCandidateName.toLowerCase()
            );

            if (similarity > bestSimilarity && similarity >= CONFIG.eventMatching.nameSimilarity) {
                bestMatch = candidate;
                bestSimilarity = similarity;
            }
        }

        if (bestMatch) {
            logger.info('Found matching pre-event', {
                preEventId: bestMatch.id,
                similarity: bestSimilarity,
                providerEventName: eventName,
                normalizedProviderEventName: normalizedEventName,
                preEventName: bestMatch.name
            });

            // Enrich pre-event if needed
            await this.enrichPreEvent(bestMatch.id, providerEvent, trx);

            return bestMatch.id;
        }

        // No match found, create new pre-event with normalized name
        logger.info('No match found, creating new pre-event', {
            eventName: normalizedEventName,
            originalEventName: eventName,
            eventStartTime,
            preCompetitionId
        });

        const adapter = getSportAdapter();
        const preEventData: any = {
            name: normalizedEventName,
            pre_competition_id: preCompetitionId,
            start_time: eventStartTime,
            event_status_id: providerEvent.event_status_id || EVENT_STATUS_IDS.PRE_RACE,
            ew_place: providerEvent.ew_place || null,
            ew_price: providerEvent.ew_price || null,
            dividend_info: providerEvent.dividend_info || null
        };
        adapter.hooks.event.applyPreEventCreateFields({
            data: {
                distance: providerEvent.distance,
                handicap: providerEvent.handicap,
            },
            insertData: preEventData,
            mergeData: preEventData,
        });

        const preEventId = await PreEventRepository.createOrUpdatePreEvent(
            preEventData,
            trx
        );

        return preEventId;
    }

    /**
     * Normalize event name by replacing venue name with canonical name if mapping exists
     * Event names are typically in format "HH:MM VenueName" (e.g., "15:00 Club Hipico")
     */
    private static async normalizeEventName(
        eventName: string,
        providerId: number | null,
        countryCode: string | null,
        trx: any
    ): Promise<string> {
        if (!eventName) return eventName;

        // Extract venue name from event name (format: "HH:MM VenueName")
        // Remove time prefix (HH:MM) and get the rest as venue name
        const venueNameMatch = eventName.match(/^\d{2}:\d{2}\s+(.+)$/);
        if (!venueNameMatch || !venueNameMatch[1]) {
            // Event name doesn't follow the expected format, return as-is
            return eventName;
        }

        const venueName = venueNameMatch[1].trim();
        if (!venueName) return eventName;

        // If we have provider_id, check for specific mapping
        if (providerId) {
            const mapping = await VenueNameMapRepository.getProviderMapping(
                venueName,
                providerId,
                countryCode || null,
                trx
            );
            if (mapping) {
                // Replace venue name with canonical name
                const normalizedName = eventName.replace(venueName, mapping.canonical_venue_name);
                return normalizedName;
            }
        }

        // Try to find mapping for any provider (for pre-events that might have been created by different providers)
        // This helps when comparing pre-events that were created by different providers
        const allMappings = await VenueNameMapRepository.getAnyMapping(venueName, trx);

        if (allMappings) {
            const normalizedName = eventName.replace(venueName, allMappings.canonical_venue_name);
            return normalizedName;
        }

        return eventName;
    }


    /**
     * Enrich pre-event with missing fields from provider
     * Public method for use by ensureService
     */
    static async enrichPreEvent(
        preEventId: number,
        providerEvent: any,
        trx: any
    ): Promise<void> {
        const updates: any = {};

        const existing = await PreEventRepository.getPreEvent(preEventId, trx);

        if (!existing) {
            return;
        }

        const adapter = getSportAdapter();
        adapter.hooks.event.applyPreEventEnrichmentFields({ existing, providerEvent, updates });

        // Update event status if provider has more recent status
        if (providerEvent.event_status_id && providerEvent.event_status_id > existing.event_status_id) {
            updates.event_status_id = providerEvent.event_status_id;
        }

        if (Object.keys(updates).length > 0) {
            await PreEventRepository.updatePreEvent(preEventId, updates, trx);

            logger.debug('Enriched pre-event', {
                preEventId,
                updates
            });
        }
    }
}
