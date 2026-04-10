export interface ProviderConfig {
    id: number;
    name: string;
    includeInHealthCheck: boolean;
}

export interface CompetitionMatchingCriteria {
    venueSimilarityThreshold: number;
    requireCountryMatch: boolean;
    requireDayMatch: boolean;
    matchField: 'venue_name' | 'competition_name' | 'name';
    conflictColumns: string[];
}

export interface EventMatchingCriteria {
    nameSimilarity: number;
    timeWindowMinutes: number;
    distanceThreshold?: number;
    competitionMatch: boolean;
    participantOverlap: number;
}

export interface ParticipantMatchingCriteria {
    nameSimilarity: number;
    drawNumberMatch: boolean;
    displayNameMatch: boolean;
    slugMatch: boolean;
}

export interface SportAdapterTables {
    PROVIDER_SPORTS: string;
    PROVIDER_COMPETITIONS: string;
    PROVIDER_EVENTS: string;
    PROVIDER_MARKETS: string;
    PROVIDER_EVENT_PARTICIPANTS: string;
    PROVIDER_ODDS: string;
    /** Append-only provider odds history (generic `fs_provider_*_odds_history` name) */
    PROVIDER_ODDS_HISTORY?: string;

    PRE_COMPETITIONS: string;
    PRE_EVENTS: string;
    PRE_MARKETS: string;
    PRE_EVENT_PARTICIPANTS: string;
    PRE_ODDS: string;
    PRE_MARKET_TYPES: string;

    PRE_EVENTS_HISTORY: string;
    PRE_ODDS_HISTORY: string;
    PRE_EVENT_PARTICIPANTS_HISTORY?: string;

    VENUE_NAME_MAP?: string;
    OUTBOX_EVENTS: string;
    FAILED_EVENTS: string;
}

export interface OddsStatusConfig {
    statuses: Record<string, number>;
    boardingPriceThresholdMinutes: number;
    validStatusesForAggregation: readonly number[];
    /** Get a status ID by name, throws if not found */
    getStatus(name: string): number;
}

export interface MarketTypesConfig {
    types: Record<string, string>;
}

export interface SportAdapterPolling {
    /** Tables to poll for changes */
    tables: string[];
    /** Per-sport poll interval override in milliseconds (optional) */
    intervalMs?: number;
}

export interface SportAdapterFields {
    providerOddsMarketField: 'provider_market_id';
    marketTypeResolution: 'direct_fk';
    hasDrawNumber: boolean;
    hasJockey: boolean;
    hasSP: boolean;
    hasHandicap: boolean;
    hasDistance: boolean;
    hasSuspended: boolean;
    hasOutright: boolean;
    hasLiveStatus: boolean;
    hasParentEvent: boolean;
    hasPeriodNumber: boolean;
    hasParticipantStatus: boolean;
}

export interface ParticipantHistoryPolicy {
    trackHistory: boolean;
    includeJockeyColumn: boolean;
    includeRunnerColumn: boolean;
}

export interface ParticipantPersistenceContext {
    /** Sport-specific participant fields passed through from provider data */
    data: Record<string, any>;
    insertData: Record<string, any>;
    mergeData: Record<string, any>;
}

export interface EventPersistenceContext {
    /** Sport-specific event fields passed through from provider data */
    data: Record<string, any>;
    insertData: Record<string, any>;
    mergeData: Record<string, any>;
}

export interface EventEnrichmentContext {
    existing: any;
    providerEvent: any;
    updates: Record<string, any>;
}

export interface SportAdapterHooks {
    participant: {
        getProviderParticipantSelectColumns(baseColumns: string[]): string[];
        applyPreEventParticipantFields(ctx: ParticipantPersistenceContext): void;
        getHistoryPolicy(): ParticipantHistoryPolicy;
        isActiveParticipantFilterEnabled(): boolean;
        /** Default participant status ID (e.g. 1 = Runner for horse racing, 1 = Active for other sports) */
        getDefaultParticipantStatusId(): number;
    };
    event: {
        applyPreEventCreateFields(ctx: EventPersistenceContext): void;
        applyPreEventEnrichmentFields(ctx: EventEnrichmentContext): void;
    };
    odds: {
        supportsStartingPrice(): boolean;
    };
    metadata: {
        getSportSlug(): string;
    };
}

export interface SportAdapter {
    sport: {
        id: number;
        code: string;
        name: string;
    };
    tables: SportAdapterTables;
    polling: SportAdapterPolling;
    providers: ProviderConfig[];
    matching: {
        competition: CompetitionMatchingCriteria;
        event: EventMatchingCriteria;
        participant: ParticipantMatchingCriteria;
    };
    eventStatus: Record<string, number>;
    oddsStatus: OddsStatusConfig;
    marketTypes: MarketTypesConfig;
    fields: SportAdapterFields;
    adapterKey: string;
    hooks: SportAdapterHooks;
}

export type AdapterRegistry = Record<string, SportAdapter>;
