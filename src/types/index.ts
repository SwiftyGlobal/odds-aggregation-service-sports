/**
 * Core types for the odds aggregation service
 */

export interface ProviderConfig {
    id: number;
    name: string;
    /** When true, this provider is included in health check endpoint (recent-data check). Only affects /health. */
    includeInHealthCheck: boolean;
    apiConfig?: any;
}

export interface MatchedEvent {
    preEventId: number;
    providerEvents: ProviderEventMatch[];
    confidence: number;
    matchReason: string;
}

export interface ProviderEventMatch {
    providerId: number;
    providerEventId: number;
    eventRefId: string;
    eventName: string;
    startTime: Date;
    confidence: number;
    matchFields: string[];
}

export interface MatchedParticipant {
    preParticipantId: number;
    providerParticipants: ProviderParticipantMatch[];
    confidence: number;
    matchReason: string;
}

export interface ProviderParticipantMatch {
    providerId: number;
    providerParticipantId: number;
    participantRefId: string;
    participantName: string;
    confidence: number;
    matchFields: string[];
}

export interface AggregatedOdds {
    preEventId: number;
    preMarketTypeId: number;
    preEventParticipantId: number;
    averageOdds: number | null;
    providerCount: number;
    providerOdds: Record<number, ProviderOddsData>;
    displayOdds: Record<string, any>;
    displayOddsProviderIds: number[];
    outlierOddsProviderIds: number[];
    active: boolean;
    lastUpdated: Date;
}

export interface ProviderOddsData {
    providerId: number;
    odds: string | null;
    displayOdds: any;
    status: string;
    lastUpdated: Date;
}

export interface AggregationResult {
    success: boolean;
    eventsProcessed: number;
    participantsMatched: number;
    oddsAggregated: number;
    errors: string[];
    duration: number;
}

export interface SyncStats {
    totalEvents: number;
    matchedEvents: number;
    unmatchedEvents: number;
    totalParticipants: number;
    matchedParticipants: number;
    totalOdds: number;
    aggregatedOdds: number;
    lastSync: Date;
}

export interface CompetitionMatchingCriteria {
    venueSimilarityThreshold: number; // 0-1, venue name similarity required
    requireCountryMatch: boolean; // Country code must match
    requireDayMatch: boolean; // Day must match
}

export interface EventMatchingCriteria {
    nameSimilarity: number; // 0-1
    timeWindowMinutes: number; // minutes (configurable)
    distanceThreshold?: number; // for distance-based matching
    competitionMatch: boolean;
    participantOverlap: number; // minimum participant overlap ratio
}

export interface ParticipantMatchingCriteria {
    nameSimilarity: number; // 0-1
    drawNumberMatch: boolean;
    displayNameMatch: boolean;
    slugMatch: boolean;
}

export interface AggregationConfig {
    providers: ProviderConfig[];
    competitionMatching: CompetitionMatchingCriteria;
    eventMatching: EventMatchingCriteria;
    participantMatching: ParticipantMatchingCriteria;
    oddsCalculation: {
        averageMethod: 'arithmetic' | 'harmonic' | 'geometric';
        minProviders: number;
        maxAgeSeconds: number; // freshness window in seconds
    };
    syncInterval: number; // minutes
    batchSize: number;
    concurrency: number;
}

export interface HealthStatus {
    status: 'healthy' | 'degraded' | 'unhealthy';
    providers: Record<number, ProviderHealth>;
    lastSync: Date | null;
    uptime: number;
    memory: {
        used: number;
        total: number;
        percentage: number;
    };
}

export interface ProviderHealth {
    providerId: number;
    name: string;
    status: 'online' | 'offline' | 'error';
    lastDataReceived: Date | null;
    eventCount: number;
    participantCount: number;
    oddsCount: number;
    errorRate: number;
}

// Database entity types
export interface PreEvent {
    id: number;
    eventName: string;
    eventStateId: number;
    sportId: number;
    competitionId: number;
    eventStartTime: Date;
    eventActualStartTime?: Date;
    eventEndTime?: Date;
    version?: number;
    last_changed_at?: Date;
    event_snapshot_version?: number;
    event_snapshot_sent_at?: Date;
    created_at: Date;
    updated_at: Date;
}

export interface PreParticipant {
    id: number;
    participantType: 'horse' | 'team' | 'person' | 'syndicate' | 'other';
    name: string;
    country?: string;
    logoUrl?: string;
    extraInfo?: any;
    created_at: Date;
    updated_at: Date;
}

export interface PreEventParticipant {
    id: number;
    eventId: number;
    participantId: number;
    drawNumber?: number;
    displayName?: string;
    extraInfo?: any;
    created_at: Date;
    updated_at: Date;
}

export interface PreMarketType {
    id: number;
    marketTypeName: string;
    marketTypeCode?: string;
    sportId: number;
    created_at: Date;
    updated_at: Date;
}

export interface PreOdds {
    id: number;
    preEventId: number;
    preMarketTypeId: number;
    preEventParticipantId: number;
    averageOdds?: number;
    providerCount: number;
    providerOdds: any;
    displayOdds: any;
    displayOddsProviderIds: number[];
    outlierOddsProviderIds: number[];
    active: boolean;
    lastUpdated: Date;
    version?: number;
    last_changed_at?: Date;
    created_at: Date;
    updated_at: Date;
}

// Provider entity types
export interface ProviderEvent {
    id: number;
    preEventId?: number;
    eventRefId: string;
    eventName: string;
    sportRefId: number;
    preSportId?: number;
    eventStatusId: number;
    eventStartTime: Date;
    eventActualStartTime?: Date;
    eventEndTime?: Date;
    ewPlace?: number;
    ewPrice?: number;
    handicap?: boolean;         // Horse-racing only
    distance?: string;          // Horse-racing only
    dividendInfo?: any;
    preCompetitionId?: number;
    providerId: number;
    autoSync?: boolean;
    syncManually?: boolean;
    // Golf-specific fields
    isSuspended?: boolean;
    isOutright?: boolean;
    liveStatus?: string;
    created_at: Date;
    updated_at: Date;
}

export interface ProviderParticipant {
    id: number;
    participantRefId: string;
    participantName: string;
    providerId: number;
    preParticipantId?: number;
    participantType?: string;
    extraInfo?: any;
    created_at: Date;
    updated_at: Date;
}

export interface ProviderEventParticipant {
    id: number;
    providerEventId: number;
    providerParticipantId: number;
    participantRefId: string;
    drawNumber?: number;
    displayName?: string;
    slug?: string;
    oddsStatusId: number;
    position?: number;
    extraInfo?: any;
    preEventParticipantId?: number;
    created_at: Date;
    updated_at: Date;
}

export interface ProviderOdds {
    id: number;
    providerEventId: number;
    providerEventParticipantId: number;
    providerMarketTypeId: number;       // FK to provider_market_types
    odds?: string;
    displayOdds?: any;
    eventRefId?: string;
    sp?: string;                        // Horse-racing only
    kind?: string;                      // Golf only
    providerId: number;
    created_at: Date;
    updated_at: Date;
}

export interface ProviderOddsHistory {
    id: number;
    providerOddsId: number;
    odds?: string;
    oddsStatusId: number;
    eventStatusId: number;
    eventRefId?: string;
    created_at: Date;
}
