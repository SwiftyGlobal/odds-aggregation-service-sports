/**
 * Real-Time Aggregation Service - Polling-Based Architecture Orchestrator
 * Uses database polling to detect provider table changes and trigger aggregation
 */

import { PollingService } from './pollingService.js';
import { StatisticsService } from './statisticsService.js';
import { DatabaseService } from '../utils/database.js';
import { logger } from '../utils/logger.js';

export class RealTimeAggregationService {
    private pollingService: PollingService;
    private isRunning: boolean = false;

    constructor() {
        this.pollingService = new PollingService();
    }

    /**
     * Start real-time aggregation service
     */
    async start(): Promise<void> {
        if (this.isRunning) {
            logger.warn('Real-time aggregation service already running');
            return;
        }

        try {
            logger.info('Starting real-time aggregation service');

            // Initialize database
            DatabaseService.getInstance();

            // Start polling service
            await this.pollingService.start();

            this.isRunning = true;
            logger.info('Real-time aggregation service started successfully');

        } catch (error) {
            logger.error('Failed to start real-time aggregation service', error as Error);
            throw error;
        }
    }

    /**
     * Stop real-time aggregation service
     */
    async stop(): Promise<void> {
        if (!this.isRunning) {
            logger.warn('Real-time aggregation service not running');
            return;
        }

        try {
            logger.info('Stopping real-time aggregation service');

            await this.pollingService.stop();
            await DatabaseService.close();

            this.isRunning = false;
            logger.info('Real-time aggregation service stopped');

        } catch (error) {
            logger.error('Error stopping real-time aggregation service', error as Error);
            throw error;
        }
    }

    /**
     * Get service statistics
     */
    getStats(): any {
        return {
            running: this.isRunning,
            processing: StatisticsService.getProcessingStats(),
            healthy: this.isRunning
        };
    }

    /**
     * Health check
     */
    isHealthy(): boolean {
        return this.isRunning;
    }

    /**
     * Get polling service stats for health check
     */
    getPollingStats() {
        return this.pollingService.getStats();
    }
}
