/**
 * Odds Aggregation Service
 * Main entry point for the aggregation service
 */

// Load environment variables FIRST (this import has side effects)
import 'dotenv/config';

// Now import everything else
import { CONFIG } from './src/config/index.js';
import { AggregationService } from './src/services/aggregationService.js';
import { RealTimeAggregationService } from './src/services/realTimeAggregationService.js';
import { DatabaseService } from './src/utils/database.js';
import { logger } from './src/utils/logger.js';
import { healthCheckServer } from './src/utils/healthCheck.js';
import { metricsService } from './src/services/metricsService.js';

class AggregationServiceCLI {
    private aggregationService: AggregationService;
    private realTimeService: RealTimeAggregationService | null = null;

    constructor() {
        this.aggregationService = new AggregationService(CONFIG);
    }

    async run(): Promise<void> {
        const args = process.argv.slice(2);
        const command = args[0];

        try {
            if (!command) {
                await this.start();
                return;
            }

            switch (command) {
                case 'sync:pre':
                    await this.runPreSync();
                    break;

                case 'health':
                    await this.runHealthCheck();
                    break;

                case 'showUsage':
                    this.showUsage();
                    break;
                default:
                    logger.error('Unknown command', undefined, { command });
                    this.showUsage();
                    process.exit(1);
            }
        } catch (error) {
            logger.error('Fatal error in main', error as Error);
            await DatabaseService.close();
            process.exit(1);
        }
    }

    private async start(): Promise<void> {
        logger.info('Starting aggregation service');

        // Initialize database connection
        DatabaseService.getInstance();

        // Note: Sports and market types are now handled by seeders
        // No need to run setup - data is static and seeded once

        this.realTimeService = new RealTimeAggregationService();

        // Start health check server FIRST (before polling starts)
        healthCheckServer.setPollingStatsCallback(() => this.realTimeService!.getPollingStats());
        healthCheckServer.start();

        // Start metrics endpoint
        await metricsService.start();

        console.log('\n' + '='.repeat(80));
        console.log('ODDS AGGREGATION SERVICE STARTING');
        console.log('='.repeat(80));
        console.log('Mode: Polling');
        console.log('Poll Interval: ' + (process.env.POLL_INTERVAL_MS || '1000') + 'ms');
        console.log('Health Check: http://localhost:' + (process.env.HEALTH_CHECK_PORT || '3002'));
        console.log('Status: Starting polling service...');
        console.log('Press Ctrl+C to stop');
        console.log('='.repeat(80) + '\n');

        // Setup graceful shutdown before starting polling
        const shutdown = async () => {
            logger.info('Shutdown signal received');
            await healthCheckServer.stop();
            await metricsService.stop();
            if (this.realTimeService) {
                await this.realTimeService.stop();
            }
            await DatabaseService.close();
            logger.info('Aggregation service stopped - Exiting');
            process.exit(0);
        };

        process.on('SIGINT', shutdown);
        process.on('SIGTERM', shutdown);

        // Start polling service
        await this.realTimeService.start();

        // Keep the process alive
        await new Promise(() => { });
    }

    private async runPreSync(): Promise<void> {
        logger.info('Starting pre-layer sync');

        const stats = await this.aggregationService.getSyncStats();

        console.log('\n' + '='.repeat(80));
        console.log('PRE-LAYER SYNC STATISTICS');
        console.log('='.repeat(80));
        console.log(`Total Events: ${stats.totalEvents}`);
        console.log(`Matched Events: ${stats.matchedEvents}`);
        console.log(`Unmatched Events: ${stats.unmatchedEvents}`);
        console.log(`Total Participants: ${stats.totalParticipants}`);
        console.log(`Matched Participants: ${stats.matchedParticipants}`);
        console.log(`Total Odds: ${stats.totalOdds}`);
        console.log(`Aggregated Odds: ${stats.aggregatedOdds}`);
        console.log(`Last Sync: ${stats.lastSync || 'Never'}`);
        console.log('='.repeat(80) + '\n');
    }

    private async runHealthCheck(): Promise<void> {
        logger.info('Running health check');

        const health = await this.aggregationService.healthCheck();

        console.log('\n' + '='.repeat(80));
        console.log('HEALTH CHECK RESULTS');
        console.log('='.repeat(80));
        console.log(`Overall Status: ${health.status.toUpperCase()}`);
        console.log(`Database: ${health.database ? '✅' : '❌'}`);
        console.log(`Last Sync: ${health.lastSync || 'Never'}`);
        console.log('\nProvider Status:');

        for (const [providerId, isHealthy] of Object.entries(health.providers)) {
            const provider = CONFIG.providers.find(p => p.id === parseInt(providerId));
            console.log(`  ${provider?.name || `Provider ${providerId}`}: ${isHealthy ? '✅' : '❌'}`);
        }
        console.log('='.repeat(80) + '\n');
    }

    private showUsage(): void {
        console.log(`
Odds Aggregation Service

Usage: npm run start [command]

Commands (default: start):
  (none)           Start aggregation service (default)
  sync:pre         Show pre-layer sync statistics
  health           Run health check
  showUsage        Show this usage (npm run start:showUsage)

Examples:
  npm run start                   # Start aggregation service (default)
  npm run start:showUsage         # Show usage
  npm run sync:pre                # View stats
  npm run health                  # Health check

Environment Variables:
  NODE_ENV         Environment: development|production (default: development)
  DB_HOST          Database host (default: localhost)
  DB_PORT          Database port (default: 5432)
  DB_NAME          Database name (default: feed_sports_db)
  DB_USER          Database user (default: postgres)
  DB_PASSWORD      Database password (default: password)
  PG_SSL           Enable SSL (default: false)
  PG_POOL_MIN      Connection pool minimum (default: 0)
  PG_POOL_MAX      Connection pool maximum (default: 10)
  
  LOG_LEVEL        Log level 0-3 (default: 2)
  LOG_FORMAT       Log format: json|text (default: text)
  LOG_CONSOLE      Enable console logging (default: true)

  POLL_INTERVAL_MS   Poll interval in ms (default: 1000)
  POLL_BATCH_LIMIT   Max rows per table per cycle (default: 500)
  POLL_CONCURRENCY   Concurrent processors (default: 40)
  POLL_CATCHUP_MINUTES  Minutes of history to catch up on startup (default: 0)
    `);
    }
}

// Run the CLI if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
    const cli = new AggregationServiceCLI();
    cli.run().catch((error) => {
        logger.error('Unhandled error in CLI', error);
        process.exit(1);
    });
}
