/**
 * Ensure Service
 * Idempotent helper functions to ensure parent entities are matched before processing children
 * Uses repository pattern for database operations
 */

import { KnexClient } from '../config/knex.js';
import { logger } from '../utils/logger.js';
import { ProviderEventGroupRepository } from '../repositories/providerEventGroupRepository.js';
import { EventRepository } from '../repositories/eventRepository.js';
import { EventGroupMatchingService } from './eventGroupMatchingService.js';
import { EventMatchingService } from './eventMatchingService.js';
import { Knex } from 'knex';

export class EnsureService {
    /**
     * Ensure provider event group is linked to a canonical pre event group (idempotent).
     */
    static async ensurePreEventGroupFromProvider(
        providerEventGroupId: number,
        trx?: Knex.Transaction
    ): Promise<number> {
        const execute = async (transaction: any) => {
            const providerGroup = await ProviderEventGroupRepository.getProviderEventGroup(
                providerEventGroupId,
                transaction
            );

            if (!providerGroup) {
                throw new Error(`Provider event group not found: ${providerEventGroupId}`);
            }

            const linked =
                providerGroup.pre_event_group_id ?? providerGroup.pre_competition_id;
            if (linked) {
                logger.debug('Event group already matched', {
                    providerEventGroupId,
                    preEventGroupId: linked
                });
                return linked;
            }

            logger.info('Ensuring event group is matched', {
                providerEventGroupId,
                name: providerGroup.competition_name
            });

            const preEventGroupId = await EventGroupMatchingService.findOrCreatePreEventGroup(
                providerGroup,
                transaction
            );

            await ProviderEventGroupRepository.updatePreEventGroupId(
                providerEventGroupId,
                preEventGroupId,
                transaction
            );

            logger.info('Event group matched via ensure', {
                providerEventGroupId,
                preEventGroupId
            });

            return preEventGroupId;
        };

        if (trx) {
            return await execute(trx);
        } else {
            return await KnexClient.withTransaction(execute);
        }
    }

    /**
     * Ensure event is matched (idempotent)
     * Ensures provider event group is matched first, then matches event
     */
    static async ensurePreEventFromProvider(
        providerEventId: number,
        trx?: Knex.Transaction
    ): Promise<number> {
        const execute = async (transaction: any) => {
            const providerEvent = await EventRepository.getProviderEvent(
                providerEventId,
                transaction
            );

            if (!providerEvent) {
                throw new Error(`Provider event not found: ${providerEventId}`);
            }

            if (providerEvent.pre_event_id) {
                logger.debug('Event already matched', {
                    providerEventId,
                    preEventId: providerEvent.pre_event_id
                });
                return providerEvent.pre_event_id;
            }

            const providerEventGroupId =
                providerEvent.provider_event_group_id ?? providerEvent.provider_competition_id;
            if (!providerEventGroupId) {
                throw new Error(`Event has no provider_event_group_id: ${providerEventId}`);
            }

            const preEventGroupId = await this.ensurePreEventGroupFromProvider(
                providerEventGroupId,
                transaction
            );

            logger.info('Ensuring event is matched', {
                providerEventId,
                eventName: providerEvent.name,
                preEventGroupId
            });

            const preEventId = await EventMatchingService.findOrCreatePreEvent(
                providerEvent,
                preEventGroupId,
                transaction
            );

            await EventRepository.updatePreEventId(
                providerEventId,
                preEventId,
                transaction
            );

            logger.info('Event matched via ensure', {
                providerEventId,
                preEventId,
                preEventGroupId
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
