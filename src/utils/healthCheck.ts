/**
 * Health Check Server for Odds Aggregation Service
 * 
 * Provides /health (liveness), /ready (readiness), and /metrics endpoints
 * Port: 3002 (configurable via HEALTH_CHECK_PORT)
 */

import { createServer, IncomingMessage, ServerResponse } from 'http';
import os from 'os';
import { DatabaseService } from './database.js';
import { logger } from './logger.js';
import { StatisticsService } from '../services/statisticsService.js';

interface HealthCheckResult {
    status: 'healthy' | 'unhealthy';
    timestamp: string;
    uptime: number;
    checks: {
        database: {
            status: 'up' | 'down';
            latency?: number;
            error?: string;
        };
    };
}

interface ReadinessCheckResult extends HealthCheckResult {
    ready: boolean;
}

interface PollingStats {
    queueSize: number;
    queuePending: number;
    isRunning: boolean;
    pollCycleCount: number;
    rowsProcessedTotal: number;
    lastPollTimes: Record<string, string>;
}

class HealthCheckServer {
    private server: ReturnType<typeof createServer> | null = null;
    private startTime: number = Date.now();
    private port: number;
    private pollingStatsCallback: (() => PollingStats) | null = null;

    constructor(port: number = 3002) {
        this.port = port;
    }

    /**
     * Set callback to get polling stats from PollingService
     */
    setPollingStatsCallback(callback: () => PollingStats): void {
        this.pollingStatsCallback = callback;
    }

    /**
     * Get CPU usage percentage
     */
    private getCpuUsage(): { user: number; system: number; total: number } {
        const cpus = os.cpus();
        let totalIdle = 0;
        let totalTick = 0;

        for (const cpu of cpus) {
            for (const type in cpu.times) {
                totalTick += cpu.times[type as keyof typeof cpu.times];
            }
            totalIdle += cpu.times.idle;
        }

        const idle = totalIdle / cpus.length;
        const total = totalTick / cpus.length;
        const usage = ((total - idle) / total) * 100;

        // Get process CPU usage
        const processCpu = process.cpuUsage();
        const userCpuPercent = (processCpu.user / 1000000) / ((Date.now() - this.startTime) / 1000) * 100;
        const systemCpuPercent = (processCpu.system / 1000000) / ((Date.now() - this.startTime) / 1000) * 100;

        return {
            user: Math.min(userCpuPercent, 100),
            system: Math.min(systemCpuPercent, 100),
            total: Math.min(usage, 100)
        };
    }

    /**
     * Get memory usage
     */
    private getMemoryUsage(): {
        heapUsed: number;
        heapTotal: number;
        external: number;
        rss: number;
        heapUsedMB: number;
        heapTotalMB: number;
        rssMB: number;
        heapUsedPercent: number;
        systemTotalMB: number;
        systemFreeMB: number;
        systemUsedPercent: number;
    } {
        const memUsage = process.memoryUsage();
        const systemTotal = os.totalmem();
        const systemFree = os.freemem();

        return {
            heapUsed: memUsage.heapUsed,
            heapTotal: memUsage.heapTotal,
            external: memUsage.external,
            rss: memUsage.rss,
            heapUsedMB: Math.round(memUsage.heapUsed / 1024 / 1024 * 100) / 100,
            heapTotalMB: Math.round(memUsage.heapTotal / 1024 / 1024 * 100) / 100,
            rssMB: Math.round(memUsage.rss / 1024 / 1024 * 100) / 100,
            heapUsedPercent: Math.round((memUsage.heapUsed / memUsage.heapTotal) * 100 * 100) / 100,
            systemTotalMB: Math.round(systemTotal / 1024 / 1024),
            systemFreeMB: Math.round(systemFree / 1024 / 1024),
            systemUsedPercent: Math.round(((systemTotal - systemFree) / systemTotal) * 100 * 100) / 100
        };
    }

    /**
     * Check database connectivity and latency
     */
    private async checkDatabase(): Promise<{ status: 'up' | 'down'; latency?: number; error?: string }> {
        try {
            const start = Date.now();
            const db = DatabaseService.getInstance();

            // Simple query to check connection
            await db.raw('SELECT 1');

            const latency = Date.now() - start;

            return {
                status: 'up',
                latency
            };
        } catch (error) {
            return {
                status: 'down',
                error: (error as Error).message
            };
        }
    }

    /**
     * Liveness probe - checks if service is alive
     */
    private async handleHealthCheck(): Promise<HealthCheckResult> {
        const dbCheck = await this.checkDatabase();

        return {
            status: dbCheck.status === 'up' ? 'healthy' : 'unhealthy',
            timestamp: new Date().toISOString(),
            uptime: (Date.now() - this.startTime) / 1000,
            checks: {
                database: dbCheck
            }
        };
    }

    /**
     * Readiness probe - checks if service is ready to accept traffic
     */
    private async handleReadinessCheck(): Promise<ReadinessCheckResult> {
        const healthCheck = await this.handleHealthCheck();
        const isReady = healthCheck.status === 'healthy';

        return {
            ...healthCheck,
            ready: isReady
        };
    }

    /**
     * Metrics endpoint - Prometheus-style metrics
     */
    private async handleMetrics(): Promise<string> {
        const dbCheck = await this.checkDatabase();
        const uptime = (Date.now() - this.startTime) / 1000;
        const mem = this.getMemoryUsage();
        const cpu = this.getCpuUsage();
        const stats = StatisticsService.getProcessingStats();
        const pollingStats = this.pollingStatsCallback?.() || { queueSize: 0, queuePending: 0, isRunning: false, pollCycleCount: 0, rowsProcessedTotal: 0, lastPollTimes: {} };

        return `
# ==========================================
# Node/Process Metrics
# ==========================================

# HELP nodejs_uptime_seconds Time the process has been running in seconds
# TYPE nodejs_uptime_seconds gauge
nodejs_uptime_seconds ${uptime.toFixed(2)}

# HELP nodejs_cpu_user_percent Process CPU user time percentage
# TYPE nodejs_cpu_user_percent gauge
nodejs_cpu_user_percent ${cpu.user.toFixed(2)}

# HELP nodejs_cpu_system_percent Process CPU system time percentage
# TYPE nodejs_cpu_system_percent gauge
nodejs_cpu_system_percent ${cpu.system.toFixed(2)}

# HELP nodejs_cpu_total_percent System CPU total usage percentage
# TYPE nodejs_cpu_total_percent gauge
nodejs_cpu_total_percent ${cpu.total.toFixed(2)}


# ==========================================
# Memory Metrics
# ==========================================

# HELP nodejs_memory_heap_used_bytes Memory heap used in bytes
# TYPE nodejs_memory_heap_used_bytes gauge
nodejs_memory_heap_used_bytes ${mem.heapUsed}

# HELP nodejs_memory_heap_total_bytes Total heap size in bytes
# TYPE nodejs_memory_heap_total_bytes gauge
nodejs_memory_heap_total_bytes ${mem.heapTotal}

# HELP nodejs_memory_heap_used_mb Memory heap used in MB
# TYPE nodejs_memory_heap_used_mb gauge
nodejs_memory_heap_used_mb ${mem.heapUsedMB}

# HELP nodejs_memory_heap_used_percent Heap memory usage percentage
# TYPE nodejs_memory_heap_used_percent gauge
nodejs_memory_heap_used_percent ${mem.heapUsedPercent}

# HELP nodejs_memory_rss_mb Resident Set Size in MB
# TYPE nodejs_memory_rss_mb gauge
nodejs_memory_rss_mb ${mem.rssMB}

# HELP system_memory_total_mb System total memory in MB
# TYPE system_memory_total_mb gauge
system_memory_total_mb ${mem.systemTotalMB}

# HELP system_memory_free_mb System free memory in MB
# TYPE system_memory_free_mb gauge
system_memory_free_mb ${mem.systemFreeMB}

# HELP system_memory_used_percent System memory usage percentage
# TYPE system_memory_used_percent gauge
system_memory_used_percent ${mem.systemUsedPercent}


# ==========================================
# Database Metrics
# ==========================================

# HELP database_status Database connection status (1 = up, 0 = down)
# TYPE database_status gauge
database_status ${dbCheck.status === 'up' ? 1 : 0}

# HELP database_latency_ms Database query latency in milliseconds
# TYPE database_latency_ms gauge
database_latency_ms ${dbCheck.latency || 0}

# HELP database_pool_active Active database connections in use
# TYPE database_pool_active gauge
database_pool_active ${DatabaseService.getConnectionStats().active}

# HELP database_pool_idle Idle database connections available
# TYPE database_pool_idle gauge
database_pool_idle ${DatabaseService.getConnectionStats().idle}

# HELP database_pool_total Total database connections (active + idle)
# TYPE database_pool_total gauge
database_pool_total ${DatabaseService.getConnectionStats().total}

# HELP database_pool_waiting Queries waiting for a connection
# TYPE database_pool_waiting gauge
database_pool_waiting ${DatabaseService.getConnectionStats().waiting}

# HELP database_pool_max Maximum pool size configured
# TYPE database_pool_max gauge
database_pool_max ${DatabaseService.getConnectionStats().poolMax}


# ==========================================
# Polling Metrics
# ==========================================

# HELP polling_queue_size Number of polled rows waiting in queue
# TYPE polling_queue_size gauge
polling_queue_size ${pollingStats.queueSize}

# HELP polling_queue_pending Number of polled rows currently processing
# TYPE polling_queue_pending gauge
polling_queue_pending ${pollingStats.queuePending}

# HELP polling_is_running Polling service running status (1 = running, 0 = stopped)
# TYPE polling_is_running gauge
polling_is_running ${pollingStats.isRunning ? 1 : 0}

# HELP polling_cycle_count Total number of poll cycles completed
# TYPE polling_cycle_count counter
polling_cycle_count ${pollingStats.pollCycleCount}

# HELP polling_rows_processed_total Total rows processed across all cycles
# TYPE polling_rows_processed_total counter
polling_rows_processed_total ${pollingStats.rowsProcessedTotal}


# ==========================================
# Processing Statistics
# ==========================================

# HELP aggregation_events_processed_total Total events processed
# TYPE aggregation_events_processed_total counter
aggregation_events_processed_total ${stats.eventsProcessed}

# HELP aggregation_event_groups_matched_total Total canonical event groups matched
# TYPE aggregation_event_groups_matched_total counter
aggregation_event_groups_matched_total ${stats.eventGroupsMatched}

# HELP aggregation_event_groups_created_total Total canonical event groups created
# TYPE aggregation_event_groups_created_total counter
aggregation_event_groups_created_total ${stats.eventGroupsCreated}

# HELP aggregation_competitions_matched_total Deprecated alias for aggregation_event_groups_matched_total
# TYPE aggregation_competitions_matched_total counter
aggregation_competitions_matched_total ${stats.eventGroupsMatched}

# HELP aggregation_competitions_created_total Deprecated alias for aggregation_event_groups_created_total
# TYPE aggregation_competitions_created_total counter
aggregation_competitions_created_total ${stats.eventGroupsCreated}

# HELP aggregation_participants_matched_total Total participants matched
# TYPE aggregation_participants_matched_total counter
aggregation_participants_matched_total ${stats.participantsMatched}

# HELP aggregation_participants_created_total Total participants created
# TYPE aggregation_participants_created_total counter
aggregation_participants_created_total ${stats.participantsCreated}

# HELP aggregation_odds_aggregated_total Total odds aggregated
# TYPE aggregation_odds_aggregated_total counter
aggregation_odds_aggregated_total ${stats.oddsAggregated}

# HELP aggregation_errors_total Total processing errors
# TYPE aggregation_errors_total counter
aggregation_errors_total ${stats.errors}

# HELP aggregation_processing_rate Events processed per second
# TYPE aggregation_processing_rate gauge
aggregation_processing_rate ${stats.processingRate.toFixed(4)}
        `.trim();
    }

    /**
     * Stats endpoint - JSON format statistics
     */
    private async handleStats(): Promise<string> {
        const dbCheck = await this.checkDatabase();
        const mem = this.getMemoryUsage();
        const cpu = this.getCpuUsage();
        const stats = StatisticsService.getProcessingStats();
        const pollingStats = this.pollingStatsCallback?.() || { queueSize: 0, queuePending: 0, isRunning: false, pollCycleCount: 0, rowsProcessedTotal: 0, lastPollTimes: {} };

        return JSON.stringify({
            timestamp: new Date().toISOString(),
            uptime: (Date.now() - this.startTime) / 1000,
            cpu: {
                user: Number(cpu.user.toFixed(2)),
                system: Number(cpu.system.toFixed(2)),
                total: Number(cpu.total.toFixed(2))
            },
            memory: {
                heapUsedMB: mem.heapUsedMB,
                heapTotalMB: mem.heapTotalMB,
                heapUsedPercent: mem.heapUsedPercent,
                rssMB: mem.rssMB,
                systemTotalMB: mem.systemTotalMB,
                systemFreeMB: mem.systemFreeMB,
                systemUsedPercent: mem.systemUsedPercent
            },
            database: {
                status: dbCheck.status,
                latencyMs: dbCheck.latency || null,
                error: dbCheck.error || null,
                pool: DatabaseService.getConnectionStats()
            },
            polling: {
                queueSize: pollingStats.queueSize,
                queuePending: pollingStats.queuePending,
                isRunning: pollingStats.isRunning,
                pollCycleCount: pollingStats.pollCycleCount,
                rowsProcessedTotal: pollingStats.rowsProcessedTotal,
                lastPollTimes: pollingStats.lastPollTimes
            },
            processing: {
                eventsProcessed: stats.eventsProcessed,
                eventGroupsMatched: stats.eventGroupsMatched,
                eventGroupsCreated: stats.eventGroupsCreated,
                participantsMatched: stats.participantsMatched,
                participantsCreated: stats.participantsCreated,
                oddsAggregated: stats.oddsAggregated,
                errors: stats.errors,
                processingRate: Number(stats.processingRate.toFixed(4))
            }
        }, null, 2);
    }

    /**
     * Help endpoint
     */
    private handleHelp(): string {
        return JSON.stringify({
            timestamp: new Date().toISOString(),
            service: 'Odds Aggregation Service Health Check Server',
            port: this.port,
            endpoints: {
                '/health': 'Liveness probe - checks if service is running',
                '/ready': 'Readiness probe - checks if service is ready to serve traffic',
                '/metrics': 'Prometheus-style metrics (CPU, memory, database, processing stats)',
                '/stats': 'JSON format statistics',
                '/help': 'This help message'
            },
            description: 'Health check server for AWS ECS with CPU, memory, and processing statistics'
        }, null, 2);
    }

    /**
     * Handle HTTP requests
     */
    private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
        const url = req.url || '/';

        try {
            if (url === '/health') {
                const result = await this.handleHealthCheck();
                res.writeHead(result.status === 'healthy' ? 200 : 503, {
                    'Content-Type': 'application/json'
                });
                res.end(JSON.stringify(result, null, 2));

            } else if (url === '/ready') {
                const result = await this.handleReadinessCheck();
                res.writeHead(result.ready ? 200 : 503, {
                    'Content-Type': 'application/json'
                });
                res.end(JSON.stringify(result, null, 2));

            } else if (url === '/metrics') {
                const metrics = await this.handleMetrics();
                res.writeHead(200, {
                    'Content-Type': 'text/plain; version=0.0.4'
                });
                res.end(metrics);

            } else if (url === '/stats') {
                const stats = await this.handleStats();
                res.writeHead(200, {
                    'Content-Type': 'application/json'
                });
                res.end(stats);

            } else if (url === '/help' || url === '/') {
                const help = this.handleHelp();
                res.writeHead(200, {
                    'Content-Type': 'application/json'
                });
                res.end(help);

            } else {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Not found' }));
            }

        } catch (error) {
            logger.error('Health check error', error as Error);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                status: 'unhealthy',
                error: (error as Error).message
            }));
        }
    }

    /**
     * Start the health check server
     */
    start(): void {
        this.server = createServer((req, res) => {
            this.handleRequest(req, res).catch(error => {
                logger.error('Unhandled error in health check server', error);
            });
        });

        this.server.listen(this.port, () => {
            logger.info('Health check server started', { port: this.port });
        });

        // Handle server errors
        this.server.on('error', (error) => {
            logger.error('Health check server error', error);
        });
    }

    /**
     * Stop the health check server
     */
    async stop(): Promise<void> {
        if (this.server) {
            return new Promise((resolve, reject) => {
                this.server!.close((error) => {
                    if (error) {
                        logger.error('Error stopping health check server', error);
                        reject(error);
                    } else {
                        logger.info('Health check server stopped');
                        resolve();
                    }
                });
            });
        }
    }
}

// Export singleton instance
export const healthCheckServer = new HealthCheckServer(
    parseInt(process.env.HEALTH_CHECK_PORT || '3002', 10)
);

