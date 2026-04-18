/**
 * Event Period Matching Service
 *
 * Resolves a provider event period (e.g. a golf tournament round) to its
 * canonical `fs_pre_event_periods` row. Called from:
 *   - the polling router when a provider period row changes
 *   - `EnsureService.ensurePreEventPeriodFromProvider` when market matching
 *     needs the canonical period id for a market that is period-scoped
 */

import { logger } from '../utils/logger.js';
import { EventPeriodRepository } from '../repositories/eventPeriodRepository.js';
import { EnsureService } from './ensureService.js';
import { DatabaseService } from '../utils/database.js';
import { DbConcurrencyManager } from '../utils/dbConcurrencyManager.js';
import { Knex } from 'knex';

export class EventPeriodMatchingService {
    static async processEventPeriodChange(
        providerEventPeriodId: number,
        lsn: string
    ): Promise<void> {
        const operationId = `period-${providerEventPeriodId}-${lsn}`;
        await DbConcurrencyManager.acquireDbSlot(operationId);
        try {
            await DatabaseService.withRetryableTransaction(async (trx) => {
                await this.execute(providerEventPeriodId, lsn, trx);
            });
        } finally {
            DbConcurrencyManager.releaseDbSlot(operationId);
        }
    }

    private static async execute(
        providerEventPeriodId: number,
        lsn: string,
        trx: Knex.Transaction
    ): Promise<void> {
        const providerPeriod = await EventPeriodRepository.getProviderEventPeriod(
            providerEventPeriodId,
            trx
        );
        if (!providerPeriod) {
            logger.warn('Provider event period not found', { providerEventPeriodId });
            return;
        }

        if (providerPeriod.pre_event_period_id) {
            return;
        }

        const preEventId = await EnsureService.ensurePreEventFromProvider(
            providerPeriod.provider_event_id,
            trx
        );
        if (!preEventId) {
            logger.info('Parent event not matched yet, skipping period matching', {
                providerEventPeriodId,
                providerEventId: providerPeriod.provider_event_id,
            });
            return;
        }

        const preEventPeriodId = await EventPeriodRepository.findOrCreatePreEventPeriod(
            preEventId,
            providerPeriod.period_type,
            providerPeriod.period_number,
            trx
        );

        await EventPeriodRepository.updatePreEventPeriodId(
            providerEventPeriodId,
            preEventPeriodId,
            trx
        );

        logger.info('Event period matched', {
            providerEventPeriodId,
            preEventPeriodId,
            preEventId,
            periodType: providerPeriod.period_type,
            periodNumber: providerPeriod.period_number,
            lsn,
        });
    }

    /**
     * Idempotent helper: resolve a provider period row to a canonical period id,
     * creating the canonical row if needed. Safe to call multiple times.
     */
    static async ensurePreEventPeriod(
        providerEventPeriodId: number,
        trx: Knex.Transaction
    ): Promise<number | null> {
        const providerPeriod = await EventPeriodRepository.getProviderEventPeriod(
            providerEventPeriodId,
            trx
        );
        if (!providerPeriod) return null;
        if (providerPeriod.pre_event_period_id) {
            return providerPeriod.pre_event_period_id;
        }

        const preEventId = await EnsureService.ensurePreEventFromProvider(
            providerPeriod.provider_event_id,
            trx
        );
        if (!preEventId) return null;

        const preEventPeriodId = await EventPeriodRepository.findOrCreatePreEventPeriod(
            preEventId,
            providerPeriod.period_type,
            providerPeriod.period_number,
            trx
        );

        await EventPeriodRepository.updatePreEventPeriodId(
            providerEventPeriodId,
            preEventPeriodId,
            trx
        );

        return preEventPeriodId;
    }
}
