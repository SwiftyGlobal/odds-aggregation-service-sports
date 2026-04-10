/**
 * Outbox payload builder utilities
 */

import { OUTBOX_SCHEMA_VERSION } from '../constants/outbox.js';
import { getSportAdapter } from '../adapters/index.js';

const parseJson = (value: any, fallback: any) => {
    if (value == null) return fallback;
    if (typeof value === 'string') {
        try {
            return JSON.parse(value);
        } catch {
            return fallback;
        }
    }
    return value;
};

const toIso = (value: any): string | null => {
    if (!value) return null;
    try {
        return new Date(value).toISOString();
    } catch {
        return null;
    }
};

export const buildSelectionKey = (
    preMarketId: number,
    optionKey: string
): string => `${preMarketId}:${optionKey}`;

export const buildPreOddsDeltaPayload = (params: {
    preOdds: any;
    selectionKey: string;
}): Record<string, any> => {
    const { preOdds, selectionKey } = params;

    const displayOdds = parseJson(preOdds?.display_odds, {});

    return {
        schema_version: OUTBOX_SCHEMA_VERSION,
        version: preOdds?.version ?? 1,
        event_id: preOdds?.event_id ?? preOdds?.pre_event_id ?? null,
        participant_id:
            preOdds?.pre_event_entry_id ??
            preOdds?.event_entry_id ??
            preOdds?.pre_event_participant_id ??
            null,
        market_id: preOdds?.market_id ?? preOdds?.pre_market_id ?? null,
        option_key: preOdds?.option_key ?? null,
        selection_key: selectionKey,
        decimal: displayOdds?.decimal ?? null,
        fractional: displayOdds?.fractional ?? null,
        active: preOdds?.active ?? false,
        odds_status_id: preOdds?.odds_status_id ?? null,
    };
};

export const buildPreEventFullPayload = (params: {
    preEvent: any;
    preCompetition?: any | null;
    participants: any[];
    version: number;
}): Record<string, any> => {
    const { preEvent, preCompetition, participants, version } = params;

    const displayDividendInfo = parseJson(preEvent?.display_dividend_info, null);

    const fields = getSportAdapter().fields;

    const participantPayload = (participants || [])
        .slice()
        .sort((a, b) => (a?.id ?? 0) - (b?.id ?? 0))
        .map((p) => {
            const extraInfo = parseJson(p.extra_info, {});

            const entry: Record<string, any> = {
                id: p.id ?? p.entry_id ?? null,
                display_name: p.display_name ?? p.name ?? null,
                slug: p.slug ?? p.ref_id ?? null,
                position: p.position ?? null,
            };

            // Sport-specific participant fields — only include when adapter supports them
            if (fields.hasParticipantStatus) {
                entry.participant_status_id = p.participant_status_id ?? null;
            }
            if (fields.hasJockey) {
                entry.jockey = p.jockey ?? null;
                entry.silk_info = extraInfo?.silk_info ?? null;
                entry.stall = extraInfo?.stall ?? null;
                entry.age = extraInfo?.age ?? null;
                entry.weight = extraInfo?.weight ?? null;
                entry.trainer = extraInfo?.trainer ?? null;
                entry.owner = extraInfo?.owner ?? null;
            }
            if (fields.hasDrawNumber) {
                entry.draw_number = p.draw_number ?? null;
            }

            return entry;
        });

    const eventPayload: Record<string, any> = {
        schema_version: OUTBOX_SCHEMA_VERSION,
        version,
        event_id: preEvent?.id ?? null,
        event_name: preEvent?.event_name ?? null,
        event_start_time: toIso(preEvent?.event_start_time),
        event_actual_start_time: toIso(preEvent?.event_actual_start_time),
        event_end_time: toIso(preEvent?.event_end_time),
        event_status_id: preEvent?.event_status_id ?? null,
        venue: preCompetition?.venue_name ?? null,
        country_code: preCompetition?.country_code ?? null,
        ew_place: preEvent?.ew_place ?? null,
        ew_price: preEvent?.ew_price ?? null,
        display_dividend_info: displayDividendInfo,
        last_changed_at: toIso(preEvent?.last_changed_at),
        participants: participantPayload,
    };

    // Sport-specific event fields — only include when adapter supports them
    if (fields.hasDistance) {
        eventPayload.distance = preEvent?.distance ?? null;
    }
    if (fields.hasHandicap) {
        eventPayload.handicap = preEvent?.handicap ?? null;
    }

    return eventPayload;
};
