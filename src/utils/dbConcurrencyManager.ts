/**
 * DB Concurrency Manager
 * Controls concurrent database operations to prevent connection pool exhaustion
 * Also provides per-preEventId locking to prevent deadlocks
 */

import { logger } from './logger.js';

// Per-preEventId lock to serialize operations and prevent deadlocks
// Each entry is a promise that resolves when the current operation completes
const preEventLocks = new Map<string, Promise<void>>();

export class DbConcurrencyManager {
    private static currentDbConcurrency = 0;
    private static readonly maxDbConcurrency = Number(process.env.DB_CONCURRENCY ?? process.env.CDC_DB_CONCURRENCY ?? '15');

    /**
     * Acquire an exclusive lock for a preEventId
     * This serializes all operations for a given pre_event, preventing deadlocks
     * Returns a release function that MUST be called when done
     */
    static async acquirePreEventLock(preEventId: string | number): Promise<() => void> {
        const key = String(preEventId);

        // Wait for any existing operation on this preEventId to complete
        while (preEventLocks.has(key)) {
            try {
                await preEventLocks.get(key);
            } catch {
                // Previous operation failed, that's ok, we can proceed
            }
        }

        // Create a new promise that we'll resolve when this operation completes
        let releaseFn: () => void = () => { };
        const lockPromise = new Promise<void>((resolve) => {
            releaseFn = () => {
                preEventLocks.delete(key);
                resolve();
            };
        });

        preEventLocks.set(key, lockPromise);

        return releaseFn;
    }

    /**
     * Acquire a DB slot for processing (semaphore pattern)
     * Waits until a slot is available if max concurrency is reached
     */
    static async acquireDbSlot(operationId: string): Promise<void> {
        while (this.currentDbConcurrency >= this.maxDbConcurrency) {
            // Back off a bit; we don't want a tight spin loop
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        this.currentDbConcurrency++;
        logger.debug('DB slot acquired', {
            operationId,
            currentDbConcurrency: this.currentDbConcurrency,
            maxDbConcurrency: this.maxDbConcurrency
        });
    }

    /**
     * Release a DB slot after processing completes
     */
    static releaseDbSlot(operationId: string): void {
        if (this.currentDbConcurrency > 0) {
            this.currentDbConcurrency--;
        }
        logger.debug('DB slot released', {
            operationId,
            currentDbConcurrency: this.currentDbConcurrency,
            maxDbConcurrency: this.maxDbConcurrency
        });
    }

    /**
     * Get current concurrency stats
     */
    static getStats(): { current: number; max: number } {
        return {
            current: this.currentDbConcurrency,
            max: this.maxDbConcurrency
        };
    }
}
