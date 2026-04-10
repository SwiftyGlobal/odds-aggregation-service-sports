/**
 * Aggregation Service - Statistics and Health Check
 * Provides sync statistics and health check functionality
 */

import { AggregationConfig, SyncStats } from '../types/index.js';
import { DatabaseService } from '../utils/database.js';
import { StatisticsRepository } from '../repositories/statisticsRepository.js';

export class AggregationService {
    private config: AggregationConfig;

    constructor(config: AggregationConfig) {
        this.config = config;
    }

    /**
     * Get sync statistics
     */
    async getSyncStats(): Promise<SyncStats> {
        return await StatisticsRepository.getSyncStats();
    }

    /**
     * Health check
     */
    async healthCheck(): Promise<{
        status: 'healthy' | 'degraded' | 'unhealthy';
        database: boolean;
        providers: Record<number, boolean>;
        lastSync: Date | null;
    }> {
        const database = await DatabaseService.healthCheck();

        const providers: Record<number, boolean> = {};
        const providersToCheck = this.config.providers.filter(p => p.includeInHealthCheck);
        for (const provider of providersToCheck) {
            providers[provider.id] = await StatisticsRepository.hasRecentProviderData(provider.id);
        }

        const stats = await this.getSyncStats();
        const status = database && Object.values(providers).some(Boolean) ? 'healthy' : 'degraded';

        return {
            status,
            database,
            providers,
            lastSync: stats.lastSync
        };
    }
}
