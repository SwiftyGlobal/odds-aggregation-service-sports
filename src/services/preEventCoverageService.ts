/**
 * Pre Event Coverage Service
 * Computes and maintains linked_provider_ids on pre-events.
 *
 * Sports schema persists a single coverage array at event level:
 * fs_pre_events.linked_provider_ids (= union of provider_ids with any linked provider_event).
 */

import { Knex } from 'knex';
import { DatabaseService } from '../utils/database.js';
import { logger } from '../utils/logger.js';
import { PreEventRepository } from '../repositories/preEventRepository.js';
import { PreEventCoverageRepository } from '../repositories/preEventCoverageRepository.js';

export class PreEventCoverageService {
    private static db = DatabaseService.getInstance();

    /**
     * Update coverage tracking fields for a pre-event
     * Idempotent and concurrency-safe.
     *
     * @param preEventId - The pre-event ID
     * @param trx - Optional transaction (if not provided, will create one)
     */
    static async updatePreEventCoverage(
        preEventId: number,
        trx?: Knex.Transaction
    ): Promise<void> {
        const execute = async (transaction: Knex.Transaction) => {
            // Lock pre-event row for update (concurrency-safe)
            const preEvent = await PreEventRepository.lockForUpdate(preEventId, transaction);

            if (!preEvent) {
                logger.warn('Pre-event not found for coverage update', { preEventId });
                return;
            }

            const linkedProviderIds = await PreEventCoverageRepository.computeLinkedProviderIds(
                preEventId,
                transaction
            );

            await PreEventRepository.updateCoverage(preEventId, { linkedProviderIds }, transaction);

            logger.debug('Pre-event coverage updated', {
                preEventId,
                linkedCount: linkedProviderIds.length,
            });
        };

        if (trx) {
            await execute(trx);
        } else {
            await this.db.transaction(execute);
        }
    }
}
