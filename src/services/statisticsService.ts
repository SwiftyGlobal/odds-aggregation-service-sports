/**
 * Statistics Service - Handles processing statistics and metrics
 * Focused on statistics tracking and reporting
 */

export interface ProcessingStats {
    eventsProcessed: number;
    competitionsMatched: number;
    competitionsCreated: number;
    participantsMatched: number;
    participantsCreated: number;
    oddsAggregated: number;
    errors: number;
    startTime: Date;
}

export class StatisticsService {
    private static stats: ProcessingStats = {
        eventsProcessed: 0,
        competitionsMatched: 0,
        competitionsCreated: 0,
        participantsMatched: 0,
        participantsCreated: 0,
        oddsAggregated: 0,
        errors: 0,
        startTime: new Date()
    };

    /**
     * Increment events processed
     */
    static incrementEventsProcessed(): void {
        this.stats.eventsProcessed++;
    }

    /**
     * Increment competitions matched
     */
    static incrementCompetitionsMatched(): void {
        this.stats.competitionsMatched++;
    }

    /**
     * Increment competitions created
     */
    static incrementCompetitionsCreated(): void {
        this.stats.competitionsCreated++;
    }

    /**
     * Increment participants matched
     */
    static incrementParticipantsMatched(): void {
        this.stats.participantsMatched++;
    }

    /**
     * Increment participants created
     */
    static incrementParticipantsCreated(): void {
        this.stats.participantsCreated++;
    }

    /**
     * Increment odds aggregated
     */
    static incrementOddsAggregated(count: number = 1): void {
        this.stats.oddsAggregated += count;
    }

    /**
     * Increment errors
     */
    static incrementErrors(): void {
        this.stats.errors++;
    }

    /**
     * Get processing statistics
     */
    static getProcessingStats(): {
        eventsProcessed: number;
        competitionsMatched: number;
        competitionsCreated: number;
        participantsMatched: number;
        participantsCreated: number;
        oddsAggregated: number;
        errors: number;
        uptime: number;
        processingRate: number;
    } {
        const uptimeMs = Date.now() - this.stats.startTime.getTime();
        const processingRate = this.stats.eventsProcessed / (uptimeMs / 1000); // events per second

        return {
            ...this.stats,
            uptime: uptimeMs,
            processingRate
        };
    }

    /**
     * Reset statistics
     */
    static resetStats(): void {
        this.stats = {
            eventsProcessed: 0,
            competitionsMatched: 0,
            competitionsCreated: 0,
            participantsMatched: 0,
            participantsCreated: 0,
            oddsAggregated: 0,
            errors: 0,
            startTime: new Date()
        };
    }

    /**
     * Get current stats snapshot
     */
    static getStats(): ProcessingStats {
        return { ...this.stats };
    }
}

