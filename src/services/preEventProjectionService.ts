/**
 * Pre Event Projection Service
 *
 * Projects optional racing-style data from provider tables to pre tables:
 * - dividend_info (provider events -> pre events map + display_dividend_info)
 * - positions (provider participants -> pre participants with source tracking)
 * - monitoring_started_at / monitoring_ended_at (lifecycle timestamps)
 *
 * All methods are gated by `adapter.hooks.projection.supportsDividendInfo()`.
 * Golf returns `false`; the methods become no-ops. Racing adapters that
 * need this projection should re-enable the body via the same hook and
 * provide implementations against their own provider columns.
 */

import { Knex } from 'knex';
import { logger } from '../utils/logger.js';
import { getSportAdapter } from '../adapters/index.js';
import { PreEventRepository } from '../repositories/preEventRepository.js';
import { EVENT_STATUS_IDS } from '../constants/status.js';

function dividendProjectionEnabled(): boolean {
    return getSportAdapter().hooks.projection.supportsDividendInfo();
}

export class PreEventProjectionService {
    static async projectDividendInfo(
        preEventId: number,
        triggerProviderId: number,
        trx: Knex.Transaction
    ): Promise<void> {
        if (!dividendProjectionEnabled()) return;
        void preEventId;
        void triggerProviderId;
        void trx;
        logger.debug('projectDividendInfo: no-op for current adapter', { preEventId });
    }

    static async projectPositions(
        preEventId: number,
        trx: Knex.Transaction
    ): Promise<void> {
        if (!dividendProjectionEnabled()) return;
        void preEventId;
        void trx;
        logger.debug('projectPositions: no-op for current adapter', { preEventId });
    }

    /**
     * Ensure fs_pre_events.monitoring_started_at is populated (idempotent, never overwrites).
     * Runs for every adapter — the column now lives in the shared sports schema.
     */
    static async ensureMonitoringStarted(
        preEventId: number,
        trx: Knex.Transaction
    ): Promise<void> {
        await PreEventRepository.ensureMonitoringStarted(preEventId, trx);
    }

    /**
     * If the pre-event has reached a terminal status (FINISHED), stamp monitoring_ended_at.
     * Idempotent — only moves the timestamp forward.
     */
    static async checkAndSetMonitoringEnded(
        preEventId: number,
        trx: Knex.Transaction
    ): Promise<void> {
        const preEvent = await PreEventRepository.getPreEvent(preEventId, trx);
        if (!preEvent) return;

        const finishedId = EVENT_STATUS_IDS.FINISHED;
        if (finishedId == null) return;

        if (Number(preEvent.event_status_id) !== Number(finishedId)) return;

        await PreEventRepository.updateMonitoringEndedAt(preEventId, new Date(), trx);
    }
}
