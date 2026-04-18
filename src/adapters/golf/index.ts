import type { SportAdapter } from '../types.js';

function healthCheckEnabled(key: string): boolean {
    return process.env[key] !== 'false';
}

export const golfAdapter: SportAdapter = {
    sport: {
        id: 2,
        code: 'GOLF',
        name: 'Golf',
    },
    tables: {
        PROVIDER_SPORTS: 'fs_provider_sports',
        PROVIDER_PARTICIPANTS: 'fs_provider_participants',
        PROVIDER_EVENT_GROUPS: 'fs_provider_event_groups',
        PROVIDER_EVENTS: 'fs_provider_events',
        PROVIDER_EVENT_PERIODS: 'fs_provider_event_periods',
        PROVIDER_MARKETS: 'fs_provider_markets',
        PROVIDER_EVENT_PARTICIPANTS: 'fs_provider_event_entries',
        PROVIDER_ODDS: 'fs_provider_selections',
        PROVIDER_ODDS_HISTORY: 'fs_provider_selection_price_history',
        PRE_EVENT_GROUPS: 'fs_pre_event_groups',
        PRE_EVENTS: 'fs_pre_events',
        PRE_EVENT_PERIODS: 'fs_pre_event_periods',
        PRE_MARKETS: 'fs_pre_markets',
        PRE_PARTICIPANTS: 'fs_pre_participants',
        PRE_EVENT_PARTICIPANTS: 'fs_pre_event_entries',
        PRE_ODDS: 'fs_pre_selections',
        PRE_MARKET_TYPES: 'fs_ref_market_templates',
        PRE_EVENTS_HISTORY: 'fs_pre_event_periods',
        PRE_ODDS_HISTORY: 'fs_pre_selection_price_history',
        PRE_EVENT_PARTICIPANTS_HISTORY: 'fs_pre_event_entries',
        OUTBOX_EVENTS: 'fs_outbox_events',
        FAILED_EVENTS: 'fs_cdc_failed_events',
    },
    polling: {
        tables: [
            'fs_provider_event_groups',
            'fs_provider_events',
            'fs_provider_event_periods',
            'fs_provider_markets',
            'fs_provider_event_entries',
            'fs_provider_selections',
        ],
    },
    providers: [
        { id: 1, name: 'unibet', includeInHealthCheck: healthCheckEnabled('HEALTH_CHECK_UNIBET_ENABLED') },
        { id: 2, name: 'coral', includeInHealthCheck: healthCheckEnabled('HEALTH_CHECK_CORAL_ENABLED') },
        { id: 3, name: '888sport', includeInHealthCheck: healthCheckEnabled('HEALTH_CHECK_888SPORT_ENABLED') },
        { id: 4, name: 'netbet', includeInHealthCheck: healthCheckEnabled('HEALTH_CHECK_NETBET_ENABLED') },
    ],
    matching: {
        eventGroup: {
            venueSimilarityThreshold: 0.85,
            requireCountryMatch: false,
            requireDayMatch: true,
            matchField: 'name',
            conflictColumns: ['pre_sport_id', 'name', 'start_time'],
            /** Provider `day` is derived from event starts (often Jan 1 vs May); do not gate candidates on it. */
            skipDayFilterForCandidates: true,
        },
        event: {
            nameSimilarity: 0.8,
            timeWindowMinutes: 3,
            eventGroupMatch: true,
            participantOverlap: 0.6,
            /**
             * Provider start/end times are unreliable for majors; scope is already the matched
             * pre_event_group, so match on canonical group name + event name only.
             */
            golfMatchEventsByNameOnly: true,
        },
        participant: {
            nameSimilarity: 0.85,
            drawNumberMatch: false,
            displayNameMatch: true,
            slugMatch: true,
        },
    },
    eventStatus: {
        PRE_EVENT: 1,
        LIVE: 2,
        FINISHED: 3,
        /** Shared services still reference horse-racing names; keep aliases aligned with numeric flow */
        PRE_RACE: 1,
        OFF_TIME: 2,
    },
    oddsStatus: {
        statuses: {
            PRE_MATCH: 1,
            IN_PLAY: 2,
        },
        boardingPriceThresholdMinutes: 0,
        validStatusesForAggregation: [1, 2],
        getStatus(name: string): number {
            const val = this.statuses[name];
            if (val === undefined) throw new Error(`Unknown odds status: ${name}`);
            return val;
        },
    },
    marketTypes: {
        types: {
            OUTRIGHT_WINNER: 'Outright Winner',
            TOP_5: 'Top 5',
            TOP_10: 'Top 10',
            TOP_20: 'Top 20',
            THREE_BALL: 'Three Ball',
        },
    },
    fields: {
        providerOddsMarketField: 'provider_market_id',
        marketTypeResolution: 'direct_fk',
        hasSuspended: true,
        hasOutright: true,
        hasLiveStatus: true,
        hasParentEvent: false,
        hasPeriodNumber: true,
    },
    adapterKey: 'golf',
    hooks: {
        participant: {
            getProviderParticipantSelectColumns(baseColumns: string[]): string[] {
                return baseColumns;
            },
            applyPreEventParticipantFields({ data, insertData, mergeData }) {
                void data;
                void insertData;
                void mergeData;
            },
            getHistoryPolicy() {
                return {
                    trackHistory: false,
                    includeJockeyColumn: false,
                    includeRunnerColumn: false,
                };
            },
            isActiveParticipantFilterEnabled() {
                return false;
            },
            getDefaultParticipantStatusId() {
                return 1;
            },
        },
        event: {
            applyPreEventCreateFields({ data, insertData, mergeData }) {
                void data;
                void insertData;
                void mergeData;
            },
            applyPreEventEnrichmentFields({ existing, providerEvent, updates }) {
                if (providerEvent.end_time && !existing.end_time) {
                    updates.end_time = providerEvent.end_time;
                }
            },
        },
        odds: {
            supportsStartingPrice() {
                return false;
            },
        },
        projection: {
            supportsDividendInfo() {
                return false;
            },
        },
        metadata: {
            getSportSlug() {
                return 'golf';
            },
        },
    },
};
