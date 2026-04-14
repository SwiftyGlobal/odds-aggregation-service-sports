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
    /**
     * When true, competition matching uses all pre-groups for the sport (`findCandidatesForCurrentSport`)
     * instead of the same-calendar-day query (`findCandidatesByDay`). For golf when provider `day` is unreliable.
     */
    skipDayFilterForCandidates?: boolean;
}

export interface EventMatchingCriteria {
    nameSimilarity: number;
    timeWindowMinutes: number;
    distanceThreshold?: number;
    competitionMatch: boolean;
    participantOverlap: number;
    /**
     * Golf: match provider events to fs_pre_events using canonical group + event names only
     * (no start_time window). Requires competition already matched to the same pre_event_group.
     */
    golfMatchEventsByNameOnly?: boolean;
}

export interface ParticipantMatchingCriteria {
    nameSimilarity: number;
    drawNumberMatch: boolean;
    displayNameMatch: boolean;
    slugMatch: boolean;
}

export interface SportAdapterTables {
    PROVIDER_SPORTS: string;
    /** Raw provider identity rows (e.g. fs_provider_participants) */
    PROVIDER_PARTICIPANTS: string;
    PROVIDER_COMPETITIONS: string;
    PROVIDER_EVENTS: string;
    /** Provider event periods (e.g. golf rounds) */
    PROVIDER_EVENT_PERIODS?: string;
    PROVIDER_MARKETS: string;
    PROVIDER_EVENT_PARTICIPANTS: string;
    PROVIDER_ODDS: string;
    /** Append-only provider odds history (generic `fs_provider_*_odds_history` name) */
    PROVIDER_ODDS_HISTORY?: string;

    PRE_COMPETITIONS: string;
    PRE_EVENTS: string;
    /** Canonical event periods (e.g. golf rounds) */
    PRE_EVENT_PERIODS?: string;
    PRE_MARKETS: string;
    /** Canonical participants (e.g. fs_pre_participants) */
    PRE_PARTICIPANTS: string;
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
    /**
     * Tie-break column for ORDER BY (updated_at, ?). Defaults to `id`.
     */
    orderByIdColumn?: Record<string, string>;
}

/**
 * Sport-agnostic feature flags. Anything that is racing-specific
 * (jockey, draw number, handicap, distance, SP, participant status)
 * was removed in the schema-hardening cleanup. If a future racing
 * adapter needs those fields, route them through `extensions`.
 */
export interface SportAdapterFields {
    providerOddsMarketField: 'provider_market_id';
    marketTypeResolution: 'direct_fk';
    hasSuspended: boolean;
    hasOutright: boolean;
    hasLiveStatus: boolean;
    hasParentEvent: boolean;
    hasPeriodNumber: boolean;
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
    /**
     * Participant hooks. The four hooks below
     * (`getProviderParticipantSelectColumns`, `getHistoryPolicy`,
     * `isActiveParticipantFilterEnabled`, `getDefaultParticipantStatusId`)
     * exist to support racing-style participant tracking. They are
     * deprecated for non-racing adapters; their consumer code paths in
     * preEventParticipantRepository / preEventParticipantHistoryRepository
     * are guarded so that golf-style adapters can return safe no-ops.
     */
    participant: {
        /** @deprecated racing-only; non-racing adapters should return baseColumns */
        getProviderParticipantSelectColumns(baseColumns: string[]): string[];
        applyPreEventParticipantFields(ctx: ParticipantPersistenceContext): void;
        /** @deprecated racing-only; non-racing adapters should return trackHistory:false */
        getHistoryPolicy(): ParticipantHistoryPolicy;
        /** @deprecated racing-only; non-racing adapters should return false */
        isActiveParticipantFilterEnabled(): boolean;
        /** @deprecated racing-only; non-racing adapters should return 1 */
        getDefaultParticipantStatusId(): number;
    };
    event: {
        applyPreEventCreateFields(ctx: EventPersistenceContext): void;
        applyPreEventEnrichmentFields(ctx: EventEnrichmentContext): void;
    };
    odds: {
        supportsStartingPrice(): boolean;
    };
    projection: {
        /** Whether the adapter wants dividend-info projection (racing). Golf returns false. */
        supportsDividendInfo(): boolean;
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
    /** Free-form bag for sport-specific toggles (e.g. racing extensions). */
    extensions?: Record<string, unknown>;
}

export type AdapterRegistry = Record<string, SportAdapter>;
