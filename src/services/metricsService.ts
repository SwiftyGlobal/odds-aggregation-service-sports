/**
 * Metrics Service
 *
 * In-process counters, gauges, and a small histogram-lite for latency.
 * Exposes a tiny HTTP `/metrics` endpoint in Prometheus text exposition
 * format. No external dependencies (no prom-client).
 *
 * Usage:
 *   metricsService.increment('market_matching.missing_ref_template', { provider_id: 4 });
 *   metricsService.gauge('outbox_unpublished_count', 42);
 *   metricsService.observe('processing_latency_ms', durationMs, { table: 'fs_provider_markets', op: 'project' });
 *   await metricsService.start(); // launches HTTP server
 */

import http from 'http';
import { logger } from '../utils/logger.js';
import { KnexClient } from '../config/knex.js';
import { TABLES } from '../constants/tables.js';
import { getSportAdapter } from '../adapters/index.js';

type Labels = Record<string, string | number>;

const RING_SIZE = 256;

function labelKey(labels?: Labels): string {
    if (!labels) return '';
    const keys = Object.keys(labels).sort();
    if (keys.length === 0) return '';
    return keys.map((k) => `${k}=${String(labels[k])}`).join(',');
}

function formatLabels(labelStr: string): string {
    if (!labelStr) return '';
    const parts = labelStr.split(',').map((kv) => {
        const [k, v] = kv.split('=');
        return `${k}="${String(v).replace(/"/g, '\\"')}"`;
    });
    return `{${parts.join(',')}}`;
}

class MetricsService {
    private counters: Map<string, Map<string, number>> = new Map();
    private gauges: Map<string, Map<string, number>> = new Map();
    private histograms: Map<string, Map<string, number[]>> = new Map();
    private server: http.Server | null = null;

    increment(name: string, labels?: Labels, value: number = 1): void {
        const key = labelKey(labels);
        if (!this.counters.has(name)) this.counters.set(name, new Map());
        const series = this.counters.get(name)!;
        series.set(key, (series.get(key) ?? 0) + value);
    }

    gauge(name: string, value: number, labels?: Labels): void {
        const key = labelKey(labels);
        if (!this.gauges.has(name)) this.gauges.set(name, new Map());
        this.gauges.get(name)!.set(key, value);
    }

    observe(name: string, value: number, labels?: Labels): void {
        const key = labelKey(labels);
        if (!this.histograms.has(name)) this.histograms.set(name, new Map());
        const series = this.histograms.get(name)!;
        if (!series.has(key)) series.set(key, []);
        const buf = series.get(key)!;
        buf.push(value);
        if (buf.length > RING_SIZE) buf.shift();
    }

    private percentile(samples: number[], p: number): number {
        if (samples.length === 0) return 0;
        const sorted = [...samples].sort((a, b) => a - b);
        const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
        return sorted[idx] ?? 0;
    }

    /**
     * Recompute on-demand gauges sourced from the database before a snapshot.
     */
    async refreshDbGauges(): Promise<void> {
        try {
            const db = KnexClient.getInstance();
            const adapter = getSportAdapter();

            // outbox_unpublished_count
            try {
                const row = await db(TABLES.OUTBOX_EVENTS)
                    .whereNull('published_at')
                    .count<{ count: string }>({ count: '*' })
                    .first();
                this.gauge('outbox_unpublished_count', Number(row?.count ?? 0));
            } catch (err) {
                logger.debug('metrics: outbox_unpublished_count probe failed', { err: (err as Error).message });
            }

            // polling_lag_seconds per polled table
            for (const table of adapter.polling.tables) {
                try {
                    const row = await db(table)
                        .max<{ max: Date | null }>({ max: 'updated_at' })
                        .first();
                    const maxTs = row?.max ? new Date(row.max).getTime() : null;
                    const lag = maxTs ? Math.max(0, (Date.now() - maxTs) / 1000) : 0;
                    this.gauge('polling_lag_seconds', lag, { table });
                } catch (err) {
                    logger.debug('metrics: polling_lag probe failed', {
                        table,
                        err: (err as Error).message,
                    });
                }
            }
        } catch (err) {
            logger.debug('metrics: refreshDbGauges failed', { err: (err as Error).message });
        }
    }

    /**
     * Render the current state in Prometheus text exposition format.
     */
    render(): string {
        const lines: string[] = [];

        for (const [name, series] of this.counters) {
            lines.push(`# TYPE ${name} counter`);
            for (const [labelStr, value] of series) {
                lines.push(`${name}${formatLabels(labelStr)} ${value}`);
            }
        }

        for (const [name, series] of this.gauges) {
            lines.push(`# TYPE ${name} gauge`);
            for (const [labelStr, value] of series) {
                lines.push(`${name}${formatLabels(labelStr)} ${value}`);
            }
        }

        for (const [name, series] of this.histograms) {
            lines.push(`# TYPE ${name} summary`);
            for (const [labelStr, samples] of series) {
                if (samples.length === 0) continue;
                const sum = samples.reduce((a, b) => a + b, 0);
                const count = samples.length;
                const p50 = this.percentile(samples, 50);
                const p95 = this.percentile(samples, 95);
                const baseLabels = labelStr ? labelStr + ',' : '';
                lines.push(`${name}${formatLabels(baseLabels + 'quantile=0.5')} ${p50}`);
                lines.push(`${name}${formatLabels(baseLabels + 'quantile=0.95')} ${p95}`);
                lines.push(`${name}_sum${formatLabels(labelStr)} ${sum}`);
                lines.push(`${name}_count${formatLabels(labelStr)} ${count}`);
            }
        }

        return lines.join('\n') + '\n';
    }

    /**
     * Start the HTTP server. Idempotent.
     */
    async start(): Promise<void> {
        if (this.server) return;
        const port = Number(process.env.METRICS_PORT ?? 9464);

        this.server = http.createServer(async (req, res) => {
            if (req.url === '/metrics') {
                await this.refreshDbGauges();
                const body = this.render();
                res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
                res.end(body);
                return;
            }
            if (req.url === '/healthz') {
                res.writeHead(200, { 'Content-Type': 'text/plain' });
                res.end('ok\n');
                return;
            }
            res.writeHead(404);
            res.end();
        });

        await new Promise<void>((resolve, reject) => {
            this.server!.once('error', reject);
            this.server!.listen(port, () => {
                logger.info('Metrics endpoint listening', { port, path: '/metrics' });
                resolve();
            });
        });
    }

    async stop(): Promise<void> {
        if (!this.server) return;
        await new Promise<void>((resolve) => this.server!.close(() => resolve()));
        this.server = null;
    }
}

export const metricsService = new MetricsService();
