/**
 * Ensure Service
 * Idempotent helper functions to ensure parent entities are matched before processing children
 * Uses repository pattern for database operations
 */

import { KnexClient } from '../config/knex.js';
import { logger } from '../utils/logger.js';
import { CompetitionRepository } from '../repositories/competitionRepository.js';
import { EventRepository } from '../repositories/eventRepository.js';
import { CompetitionMatchingService } from './competitionMatchingService.js';
import { EventMatchingService } from './eventMatchingService.js';
import { Knex } from 'knex';

export class EnsureService {
    /**
     * Ensure competition is matched (idempotent)
     * Returns existing pre_competition_id if already matched, otherwise matches and returns new id
     */
    static async ensurePreCompetitionFromProvider(
        providerCompetitionId: number,
        trx?: Knex.Transaction
    ): Promise<number> {
        const execute = async (transaction: any) => {
            // Get provider competition
            const providerCompetition = await CompetitionRepository.getProviderCompetition(
                providerCompetitionId,
                transaction
            );

            if (!providerCompetition) {
                throw new Error(`Provider competition not found: ${providerCompetitionId}`);
            }

            // If already matched, return existing pre_competition_id
            if (providerCompetition.pre_competition_id) {
                logger.debug('Competition already matched', {
                    providerCompetitionId,
                    preCompetitionId: providerCompetition.pre_competition_id
                });
                return providerCompetition.pre_competition_id;
            }

            // Match or create pre-competition
            logger.info('Ensuring competition is matched', {
                providerCompetitionId,
                competitionName: providerCompetition.competition_name
            });

            const preCompetitionId = await CompetitionMatchingService.findOrCreatePreCompetition(
                providerCompetition,
                transaction
            );

            // Update provider competition with pre_competition_id
            await CompetitionRepository.updatePreCompetitionId(
                providerCompetitionId,
                preCompetitionId,
                transaction
            );

            logger.info('Competition matched via ensure', {
                providerCompetitionId,
                preCompetitionId
            });

            return preCompetitionId;
        };

        if (trx) {
            return await execute(trx);
        } else {
            return await KnexClient.withTransaction(execute);
        }
    }

    /**
     * Ensure event is matched (idempotent)
     * Ensures competition is matched first, then matches event
     * Returns existing pre_event_id if already matched, otherwise matches and returns new id
     */
    static async ensurePreEventFromProvider(
        providerEventId: number,
        trx?: Knex.Transaction
    ): Promise<number> {
        const execute = async (transaction: any) => {
            // Get provider event
            const providerEvent = await EventRepository.getProviderEvent(
                providerEventId,
                transaction
            );

            if (!providerEvent) {
                throw new Error(`Provider event not found: ${providerEventId}`);
            }

            // If already matched, return existing pre_event_id
            if (providerEvent.pre_event_id) {
                logger.debug('Event already matched', {
                    providerEventId,
                    preEventId: providerEvent.pre_event_id
                });
                return providerEvent.pre_event_id;
            }

            // Ensure competition is matched first
            if (!providerEvent.provider_competition_id) {
                throw new Error(`Event has no provider_competition_id: ${providerEventId}`);
            }

            const preCompetitionId = await this.ensurePreCompetitionFromProvider(
                providerEvent.provider_competition_id,
                transaction
            );

            // Match or create pre-event
            logger.info('Ensuring event is matched', {
                providerEventId,
                eventName: providerEvent.event_name,
                preCompetitionId
            });

            const preEventId = await EventMatchingService.findOrCreatePreEvent(
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

            logger.info('Event matched via ensure', {
                providerEventId,
                preEventId,
                preCompetitionId
            });

            return preEventId;
        };

        if (trx) {
            return await execute(trx);
        } else {
            return await KnexClient.withTransaction(execute);
        }
    }
}

