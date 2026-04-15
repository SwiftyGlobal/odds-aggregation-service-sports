/**
 * Statistics Service - Handles processing statistics and metrics
 */

export interface ProcessingStats {
    eventsProcessed: number;
    eventGroupsMatched: number;
    eventGroupsCreated: number;
    participantsMatched: number;
    participantsCreated: number;
    oddsAggregated: number;
    errors: number;
    startTime: Date;
}

export class StatisticsService {
    private static stats: ProcessingStats = {
        eventsProcessed: 0,
        eventGroupsMatched: 0,
        eventGroupsCreated: 0,
        participantsMatched: 0,
        participantsCreated: 0,
        oddsAggregated: 0,
        errors: 0,
        startTime: new Date()
    };

    static incrementEventsProcessed(): void {
        this.stats.eventsProcessed++;
    }

    static incrementEventGroupsMatched(): void {
        this.stats.eventGroupsMatched++;
    }

    static incrementEventGroupsCreated(): void {
        this.stats.eventGroupsCreated++;
    }

    static incrementParticipantsMatched(): void {
        this.stats.participantsMatched++;
    }

    static incrementParticipantsCreated(): void {
        this.stats.participantsCreated++;
    }

    static incrementOddsAggregated(count: number = 1): void {
        this.stats.oddsAggregated += count;
    }

    static incrementErrors(): void {
        this.stats.errors++;
    }

    static getProcessingStats(): {
        eventsProcessed: number;
        eventGroupsMatched: number;
        eventGroupsCreated: number;
        participantsMatched: number;
        participantsCreated: number;
        oddsAggregated: number;
        errors: number;
        uptime: number;
        processingRate: number;
    } {
        const uptimeMs = Date.now() - this.stats.startTime.getTime();
        const processingRate = this.stats.eventsProcessed / (uptimeMs / 1000);

        return {
            ...this.stats,
            uptime: uptimeMs,
            processingRate
        };
    }

    static resetStats(): void {
        this.stats = {
            eventsProcessed: 0,
            eventGroupsMatched: 0,
            eventGroupsCreated: 0,
            participantsMatched: 0,
            participantsCreated: 0,
            oddsAggregated: 0,
            errors: 0,
            startTime: new Date()
        };
    }

    static getStats(): ProcessingStats {
        return { ...this.stats };
    }
}
