import knex, { Knex } from 'knex';
import { DATABASE_CONFIG } from './index.js';
import { logger } from '../utils/logger.js';

let dbInstance: Knex | null = null;

export class KnexClient {
    static getInstance(): Knex {
        if (!dbInstance) {
            dbInstance = knex({
                client: 'pg',
                connection: DATABASE_CONFIG,
                pool: {
                    min: DATABASE_CONFIG.pool.min,
                    max: DATABASE_CONFIG.pool.max,
                    createTimeoutMillis: 30000,
                    acquireTimeoutMillis: 60000,
                    idleTimeoutMillis: 600000,
                    reapIntervalMillis: 1000,
                    createRetryIntervalMillis: 200
                },
                acquireConnectionTimeout: 60000,
                debug: process.env.DB_DEBUG === 'true'
            });

            // Setup graceful shutdown
            process.on('SIGINT', async () => {
                logger.info('Received SIGINT, closing database connection');
                await this.close();
                process.exit(0);
            });

            process.on('SIGTERM', async () => {
                logger.info('Received SIGTERM, closing database connection');
                await this.close();
                process.exit(0);
            });

            logger.info('Database connection initialized', {
                host: DATABASE_CONFIG.host,
                database: DATABASE_CONFIG.database,
                poolMin: DATABASE_CONFIG.pool.min,
                poolMax: DATABASE_CONFIG.pool.max
            });
        }

        return dbInstance;
    }

    static async close(): Promise<void> {
        if (dbInstance) {
            try {
                await dbInstance.destroy();
                dbInstance = null;
                logger.info('Database connection closed');
            } catch (error) {
                logger.error('Error closing database connection', error as Error);
            }
        }
    }

    static async healthCheck(): Promise<boolean> {
        try {
            const db = this.getInstance();
            await db.raw('SELECT 1');
            return true;
        } catch (error) {
            logger.error('Database health check failed', error as Error);
            return false;
        }
    }

    /**
     * Get detailed connection pool statistics
     */
    static getConnectionStats(): {
        active: number;
        idle: number;
        total: number;
        waiting: number;
        poolMax: number;
    } {
        if (!dbInstance) {
            return { active: 0, idle: 0, total: 0, waiting: 0, poolMax: 0 };
        }

        try {
            const pool = (dbInstance as any).client?.pool;
            if (!pool) {
                return { active: 0, idle: 0, total: 0, waiting: 0, poolMax: DATABASE_CONFIG.pool.max };
            }

            const active = pool.numUsed?.() || 0;
            const idle = pool.numFree?.() || 0;
            const waiting = pool.numPendingAcquires?.() || 0;

            return {
                active,
                idle,
                total: active + idle,
                waiting,
                poolMax: DATABASE_CONFIG.pool.max
            };
        } catch (error) {
            logger.error('Error getting connection stats', error as Error);
            return { active: 0, idle: 0, total: 0, waiting: 0, poolMax: DATABASE_CONFIG.pool.max };
        }
    }

    static async withTransaction<T>(
        callback: (trx: Knex.Transaction) => Promise<T>
    ): Promise<T> {
        const db = this.getInstance();
        return await db.transaction(callback);
    }

    static async withRetryableTransaction<T>(
        callback: (trx: Knex.Transaction) => Promise<T>,
        maxRetries: number = 3
    ): Promise<T> {
        let lastError: Error | null = null;

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                return await this.withTransaction(callback);
            } catch (error) {
                lastError = error as Error;

                if (attempt < maxRetries) {
                    const delay = 1000 * Math.pow(2, attempt); // Exponential backoff
                    logger.warn('Transaction failed, retrying', {
                        attempt: attempt + 1,
                        maxRetries,
                        delayMs: delay,
                        error: lastError.message
                    });

                    await new Promise(resolve => setTimeout(resolve, delay));
                }
            }
        }

        throw lastError || new Error('Transaction failed after all retries');
    }
}

export const db = KnexClient.getInstance();

