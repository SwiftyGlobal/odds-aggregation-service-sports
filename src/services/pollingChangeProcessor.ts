/**
 * Polling Change Processor
 * Processes polled rows and routes to matching/aggregation services.
 * Polling only sees latest state; INSERT vs UPDATE determined by created_at vs poll window.
 */

import { logger } from '../utils/logger.js';
import { TABLES } from '../constants/tables.js';
import { CompetitionMatchingService } from './competitionMatchingService.js';
import { EventMatchingService } from './eventMatchingService.js';
import { EventParticipantMatchingService } from './eventParticipantMatchingService.js';
import { MarketMatchingService } from './marketMatchingService.js';
import { OddsAggregationService } from './oddsAggregationService.js';
import { PreEventStatusService } from './preEventStatusService.js';
import { PreEventProjectionService } from './preEventProjectionService.js';
import { PreEventCoverageService } from './preEventCoverageService.js';
import { PreEventOutboxService } from './preEventOutboxService.js';
import { DatabaseService } from '../utils/database.js';
import { DbConcurrencyManager } from '../utils/dbConcurrencyManager.js';
import { EventRepository } from '../repositories/eventRepository.js';
import { EventParticipantRepository } from '../repositories/eventParticipantRepository.js';
import { getPolledRowPrimaryKey } from '../repositories/pollingRepository.js';

// Centralized deduplication: preEventId -> prevents duplicate projection transactions
const projectionInProgress = new Set<string>();

// Track which provider_event_ids are currently being processed
const eventProcessingInProgress = new Set<string>();

export class PollingChangeProcessor {
    /**
     * Process a polled row from a provider table.
     * @param table - The table name the row came from
     * @param row - The full row data from the database
     * @param isNew - Whether this row is new (INSERT-like) or updated
     * @param pollCycleId - Identifier for the poll cycle (used for logging)
     */
    static async processRow(
        table: string,
        row: any,
        isNew: boolean,
        pollCycleId: string
    ): Promise<void> {
        const rowId = getPolledRowPrimaryKey(table, row);

        if (!Number.isFinite(rowId)) {
            logger.warn('No primary key found in polled row', { table, pollCycleId });
            return;
        }

        try {
            if (table === TABLES.PROVIDER_COMPETITIONS) {
                await this.processCompetition(rowId, pollCycleId);
            } else if (table === TABLES.PROVIDER_EVENTS) {
                await this.processEvent(row, isNew, pollCycleId);
            } else if (table === TABLES.PROVIDER_EVENT_PARTICIPANTS) {
                await this.processParticipant(row, isNew, pollCycleId);
            } else if (table === TABLES.PROVIDER_MARKETS) {
                await this.processMarket(row, pollCycleId);
            } else if (table === TABLES.PROVIDER_ODDS) {
                await this.processOdds(row, pollCycleId);
            } else {
                logger.debug('No matching service for polled table', { table, pollCycleId });
            }
        } catch (error) {
            logger.error('Error processing polled row', error as Error, {
                table,
                rowId,
                pollCycleId
            });
            throw error;
        }
    }

    /**
     * COMPETITIONS - Always match (same behavior for new and updated)
     */
    private static async processCompetition(rowId: number, pollCycleId: string): Promise<void> {
        await CompetitionMatchingService.processCompetitionChange(rowId, pollCycleId);
    }

    /**
     * EVENTS - Match if not linked, then run projections
     */
    private static async processEvent(row: any, isNew: boolean, pollCycleId: string): Promise<void> {
        const rowId = row.id;
        const eventKey = `event-${rowId}`;

        // Deduplication: skip if already processing this exact event
        if (eventProcessingInProgress.has(eventKey)) {
            return;
        }
        eventProcessingInProgress.add(eventKey);

        try {
            const releaseEventLock = await DbConcurrencyManager.acquirePreEventLock(eventKey);
            try {
                // Match if new or not yet linked to a pre-event
                if (isNew || !row.pre_event_id) {
                    await EventMatchingService.processEventChange(rowId, pollCycleId);
                }

                // Handle projections
                const projectionOpId = `projection-event-${rowId}`;
                await DbConcurrencyManager.acquireDbSlot(projectionOpId);
                try {
                    await DatabaseService.withRetryableTransaction(async (trx) => {
                        const providerEvent = await EventRepository.getProviderEvent(rowId, trx);

                        if (providerEvent && providerEvent.pre_event_id && providerEvent.provider_id) {
                            await PreEventProjectionService.ensureMonitoringStarted(
                                providerEvent.pre_event_id,
                                trx
                            );

                            await PreEventProjectionService.projectDividendInfo(
                                providerEvent.pre_event_id,
                                providerEvent.provider_id,
                                trx
                            );

                            await PreEventStatusService.promoteStatusIfNeeded(
                                providerEvent.pre_event_id,
                                providerEvent.provider_id,
                                trx
                            );

                            await PreEventProjectionService.checkAndSetMonitoringEnded(
                                providerEvent.pre_event_id,
                                trx
                            );

                            await PreEventCoverageService.updatePreEventCoverage(
                                providerEvent.pre_event_id,
                                trx
                            );

                            await PreEventOutboxService.emitIfNeeded(
                                providerEvent.pre_event_id,
                                trx,
                                { force: true }
                            );
                        }
                    });
                } finally {
                    DbConcurrencyManager.releaseDbSlot(projectionOpId);
                }
            } finally {
                releaseEventLock();
            }
        } finally {
            // Keep in set for 500ms to batch closely-timed polls for same event
            setTimeout(() => {
                eventProcessingInProgress.delete(eventKey);
            }, 500);
        }
    }

    /**
     * PARTICIPANTS - Match if not linked, project positions if position exists
     */
    private static async processParticipant(row: any, isNew: boolean, pollCycleId: string): Promise<void> {
        const rowId = getPolledRowPrimaryKey(TABLES.PROVIDER_EVENT_PARTICIPANTS, row);
        const providerEventId = row.provider_event_id;
        const alreadyMatched = (row.pre_event_participant_id ?? row.pre_event_entry_id) != null;

        // Match if not yet linked
        if (!alreadyMatched) {
            if (providerEventId) {
                const releaseMatchingLock = await DbConcurrencyManager.acquirePreEventLock(`event-${providerEventId}`);
                try {
                    await EventParticipantMatchingService.processEventParticipantChange(rowId, pollCycleId);
                } finally {
                    releaseMatchingLock();
                }
            } else {
                await EventParticipantMatchingService.processEventParticipantChange(rowId, pollCycleId);
            }
        }

        // Project positions if participant has a position
        if (row.position == null) {
            return;
        }

        // Query pre_event_id AFTER matching (might have been set during matching)
        const providerParticipantInfo = await EventParticipantRepository.getProviderEventParticipantWithEvent(rowId);

        if (!providerParticipantInfo || !providerParticipantInfo.pre_event_id) {
            return;
        }

        const preEventIdForProjection = String(providerParticipantInfo.pre_event_id);

        // Check deduplication BEFORE opening transaction
        if (projectionInProgress.has(preEventIdForProjection)) {
            return;
        }
        projectionInProgress.add(preEventIdForProjection);

        const projectionOpId = `projection-participant-${rowId}`;
        await DbConcurrencyManager.acquireDbSlot(projectionOpId);
        try {
            await DatabaseService.withRetryableTransaction(async (trx) => {
                await PreEventProjectionService.projectPositions(
                    providerParticipantInfo.pre_event_id,
                    trx
                );

                await PreEventProjectionService.checkAndSetMonitoringEnded(
                    providerParticipantInfo.pre_event_id,
                    trx
                );

                await PreEventOutboxService.emitIfNeeded(
                    providerParticipantInfo.pre_event_id,
                    trx,
                    { force: true }
                );
            });
        } finally {
            DbConcurrencyManager.releaseDbSlot(projectionOpId);
            setTimeout(() => {
                projectionInProgress.delete(preEventIdForProjection);
            }, 500);
        }
    }

    /**
     * MARKETS - Always match
     */
    private static async processMarket(row: any, pollCycleId: string): Promise<void> {
        const rowId = row.id;
        const providerEventId = row.provider_event_id;

        if (providerEventId) {
            const eventKey = `event-${providerEventId}`;
            const releaseMarketLock = await DbConcurrencyManager.acquirePreEventLock(eventKey);
            try {
                await MarketMatchingService.processMarketChange(rowId, pollCycleId);
            } finally {
                releaseMarketLock();
            }
        } else {
            await MarketMatchingService.processMarketChange(rowId, pollCycleId);
        }
    }

    /**
     * ODDS - Always process (polling naturally deduplicates rapid updates)
     */
    private static async processOdds(row: any, pollCycleId: string): Promise<void> {
        const rowId = row.id;
        const providerEventId = row.provider_event_id;

        if (providerEventId) {
            const eventKey = `event-${providerEventId}`;
            const releaseOddsLock = await DbConcurrencyManager.acquirePreEventLock(eventKey);
            try {
                await OddsAggregationService.processOddsChange(rowId, pollCycleId);
            } finally {
                releaseOddsLock();
            }
        } else {
            await OddsAggregationService.processOddsChange(rowId, pollCycleId);
        }
    }
}
