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

function projectionEnabled(): boolean {
    return getSportAdapter().hooks.projection.supportsDividendInfo();
}

export class PreEventProjectionService {
    static async projectDividendInfo(
        preEventId: number,
        triggerProviderId: number,
        trx: Knex.Transaction
    ): Promise<void> {
        if (!projectionEnabled()) return;
        void preEventId;
        void triggerProviderId;
        void trx;
        logger.debug('projectDividendInfo: no-op for current adapter', { preEventId });
    }

    static async projectPositions(
        preEventId: number,
        trx: Knex.Transaction
    ): Promise<void> {
        if (!projectionEnabled()) return;
        void preEventId;
        void trx;
        logger.debug('projectPositions: no-op for current adapter', { preEventId });
    }

    static async ensureMonitoringStarted(
        preEventId: number,
        trx: Knex.Transaction
    ): Promise<void> {
        if (!projectionEnabled()) return;
        void preEventId;
        void trx;
        logger.debug('ensureMonitoringStarted: no-op for current adapter', { preEventId });
    }

    static async checkAndSetMonitoringEnded(
        preEventId: number,
        trx: Knex.Transaction
    ): Promise<void> {
        if (!projectionEnabled()) return;
        void preEventId;
        void trx;
        logger.debug('checkAndSetMonitoringEnded: no-op for current adapter', { preEventId });
    }
}
