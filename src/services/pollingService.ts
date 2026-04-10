/**
 * Polling Service
 * Polls provider tables for changes using updated_at timestamps.
 * Uses natural batching and deduplication of rapid updates.
 */

import PQueue from 'p-queue';
import { logger } from '../utils/logger.js';
import { POLLING_CONSTANTS } from '../constants/polling.js';
import { PollingRepository } from '../repositories/pollingRepository.js';
import { PollingChangeProcessor } from './pollingChangeProcessor.js';
import { isTransientError, getErrorCode } from '../utils/errorClassification.js';
import { FailedEventRepository } from '../repositories/cdcFailedEventRepository.js';

// Throttle interval for queue-size warnings (ms)
const QUEUE_WARN_INTERVAL_MS = 10_000;

interface TableState {
    lastPollTime: Date;
    /** IDs at the boundary timestamp from previous cycle (for dedup on ties) */
    boundaryIds: Set<number>;
}

export class PollingService {
    private isRunning: boolean = false;
    private pollTimer: ReturnType<typeof setInterval> | null = null;
    private lastQueueWarnAt: number = 0;
    private pollCycleCount: number = 0;
    private rowsProcessedTotal: number = 0;
    private pollInProgress: boolean = false;

    /** Per-table polling state */
    private tableStates: Map<string, TableState> = new Map();

    /** Queue for processing polled rows with controlled concurrency */
    private processingQueue: PQueue = new PQueue({
        concurrency: POLLING_CONSTANTS.POLL_CONCURRENCY,
        timeout: 120000 // 2 minute timeout per task
    });

    /**
     * Start polling service
     */
    async start(): Promise<void> {
        if (this.isRunning) {
            logger.warn('Polling service already running');
            return;
        }

        try {
            logger.info('Starting polling service', {
                intervalMs: POLLING_CONSTANTS.POLL_INTERVAL_MS,
                batchLimit: POLLING_CONSTANTS.POLL_BATCH_LIMIT,
                concurrency: POLLING_CONSTANTS.POLL_CONCURRENCY,
                catchupMinutes: POLLING_CONSTANTS.POLL_CATCHUP_MINUTES,
                tables: POLLING_CONSTANTS.MONITORED_TABLES
            });

            // Initialize per-table state
            await this.initializeTableStates();

            // Start the poll loop
            this.isRunning = true;
            this.pollTimer = setInterval(() => {
                this.pollCycle().catch(error => {
                    logger.error('Poll cycle error', error as Error);
                });
            }, POLLING_CONSTANTS.POLL_INTERVAL_MS);

            // Run first poll immediately
            this.pollCycle().catch(error => {
                logger.error('Initial poll cycle error', error as Error);
            });

            logger.info('Polling service started successfully');

        } catch (error) {
            logger.error('Failed to start polling service', error as Error);
            await this.stop();
            throw error;
        }
    }

    /**
     * Initialize polling state for each monitored table
     */
    private async initializeTableStates(): Promise<void> {
        const serverTime = await PollingRepository.getServerTime();
        const catchupMs = POLLING_CONSTANTS.POLL_CATCHUP_MINUTES * 60 * 1000;
        const startTime = new Date(serverTime.getTime() - catchupMs);

        for (const table of POLLING_CONSTANTS.MONITORED_TABLES) {
            this.tableStates.set(table, {
                lastPollTime: startTime,
                boundaryIds: new Set()
            });
        }

        logger.info('Polling state initialized', {
            startTime: startTime.toISOString(),
            catchupMinutes: POLLING_CONSTANTS.POLL_CATCHUP_MINUTES,
            tableCount: POLLING_CONSTANTS.MONITORED_TABLES.length
        });
    }

    /**
     * Execute a single poll cycle across all monitored tables
     */
    private async pollCycle(): Promise<void> {
        // Prevent overlapping poll cycles
        if (this.pollInProgress) {
            return;
        }
        this.pollInProgress = true;

        try {
            this.pollCycleCount++;
            const cycleId = `poll-${Date.now()}`;
            let totalRowsThisCycle = 0;

            for (const table of POLLING_CONSTANTS.MONITORED_TABLES) {
                const state = this.tableStates.get(table)!;

                const rows = await PollingRepository.getChangedRows(
                    table,
                    state.lastPollTime,
                    POLLING_CONSTANTS.POLL_BATCH_LIMIT
                );

                if (rows.length === 0) {
                    continue;
                }

                // Find the max updated_at in this batch for advancing the cursor
                const maxUpdatedAt = rows[rows.length - 1].updated_at;
                const maxUpdatedAtTime = new Date(maxUpdatedAt).getTime();

                // Build new boundary ID set for rows at the max timestamp
                const newBoundaryIds = new Set<number>();
                for (const row of rows) {
                    if (new Date(row.updated_at).getTime() === maxUpdatedAtTime) {
                        newBoundaryIds.add(row.id);
                    }
                }

                // Queue each row for processing (skip boundary duplicates from previous cycle)
                for (const row of rows) {
                    const rowUpdatedAtTime = new Date(row.updated_at).getTime();
                    const isAtPreviousBoundary = rowUpdatedAtTime === new Date(state.lastPollTime).getTime();

                    // Skip rows that were at the exact boundary of the previous poll
                    // and were already processed
                    if (isAtPreviousBoundary && state.boundaryIds.has(row.id)) {
                        continue;
                    }

                    const isNew = row.created_at && new Date(row.created_at) >= state.lastPollTime;

                    this.enqueueRow(table, row, isNew, cycleId);
                    totalRowsThisCycle++;
                }

                // Advance cursor
                state.lastPollTime = new Date(maxUpdatedAt);
                state.boundaryIds = newBoundaryIds;
            }

            this.rowsProcessedTotal += totalRowsThisCycle;

            if (totalRowsThisCycle > 0) {
                logger.debug('Poll cycle complete', {
                    cycleId,
                    cycleNumber: this.pollCycleCount,
                    rowsFound: totalRowsThisCycle,
                    queueSize: this.processingQueue.size,
                    queuePending: this.processingQueue.pending
                });
            }

            // Log queue status periodically for monitoring
            const now = Date.now();
            if (this.processingQueue.size > 1000 && (now - this.lastQueueWarnAt) >= QUEUE_WARN_INTERVAL_MS) {
                this.lastQueueWarnAt = now;
                logger.warn('Polling queue growing large - processing may be falling behind', {
                    pending: this.processingQueue.size,
                    active: this.processingQueue.pending
                });
            }

        } finally {
            this.pollInProgress = false;
        }
    }

    /**
     * Enqueue a single row for processing with retry logic
     */
    private enqueueRow(table: string, row: any, isNew: boolean, pollCycleId: string): void {
        this.processingQueue.add(async () => {
            let lastError: Error | null = null;

            for (let attempt = 1; attempt <= POLLING_CONSTANTS.POLL_RETRY_MAX; attempt++) {
                try {
                    await PollingChangeProcessor.processRow(table, row, isNew, pollCycleId);
                    return;
                } catch (error) {
                    lastError = error as Error;

                    if (isTransientError(error) && attempt < POLLING_CONSTANTS.POLL_RETRY_MAX) {
                        const delay = POLLING_CONSTANTS.POLL_RETRY_BASE_MS * attempt;
                        logger.warn('Transient polling error, retrying', {
                            table,
                            rowId: row.id,
                            attempt,
                            maxRetries: POLLING_CONSTANTS.POLL_RETRY_MAX,
                            delayMs: delay,
                            error: (error as Error).message
                        });
                        await new Promise(resolve => setTimeout(resolve, delay));
                        continue;
                    }

                    break;
                }
            }

            // All retries exhausted or permanent error
            logger.error('Polling processing failed permanently', lastError as Error, {
                table,
                rowId: row.id,
                pollCycleId,
                retriesExhausted: POLLING_CONSTANTS.POLL_RETRY_MAX
            });

            try {
                await FailedEventRepository.insert({
                    lsn: pollCycleId,
                    tableName: table,
                    action: isNew ? 'INSERT' : 'UPDATE',
                    payload: { id: row.id, updated_at: row.updated_at },
                    errorMessage: lastError?.message ?? 'Unknown error',
                    errorCode: getErrorCode(lastError)
                });
            } catch (insertError) {
                logger.error('Failed to save polling failed event record', insertError as Error, {
                    table,
                    rowId: row.id
                });
            }
        });
    }

    /**
     * Stop polling service
     */
    async stop(): Promise<void> {
        if (!this.isRunning) {
            return;
        }

        logger.info('Stopping polling service');
        this.isRunning = false;

        // Stop the poll timer
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
        }

        // Wait for queue to drain (with timeout)
        if (this.processingQueue.size > 0 || this.processingQueue.pending > 0) {
            logger.info('Waiting for polling queue to drain', {
                pending: this.processingQueue.size,
                active: this.processingQueue.pending
            });

            this.processingQueue.clear();
            try {
                await Promise.race([
                    this.processingQueue.onIdle(),
                    new Promise(resolve => setTimeout(resolve, 10000))
                ]);
            } catch {
                logger.warn('Timeout waiting for polling queue to drain');
            }
        }

        logger.info('Polling service stopped');
    }

    /**
     * Get polling service statistics for health check
     */
    getStats(): {
        queueSize: number;
        queuePending: number;
        isRunning: boolean;
        pollCycleCount: number;
        rowsProcessedTotal: number;
        lastPollTimes: Record<string, string>;
    } {
        const lastPollTimes: Record<string, string> = {};
        for (const [table, state] of this.tableStates) {
            lastPollTimes[table] = state.lastPollTime.toISOString();
        }

        return {
            queueSize: this.processingQueue.size,
            queuePending: this.processingQueue.pending,
            isRunning: this.isRunning,
            pollCycleCount: this.pollCycleCount,
            rowsProcessedTotal: this.rowsProcessedTotal,
            lastPollTimes
        };
    }
}
