/**
 * Ref ID Utilities
 * Generates stable, deterministic reference IDs for pre-layer entities.
 *
 * Format:
 *   competition:  HR.202603050000.USA.charles_town
 *   event:        HR.202603051700.USA.charles_town
 *   participant:  HR.202603051700.USA.charles_town.senorita_jerico
 *
 * Components:
 *   - sport_code: from the canonical sports row (e.g. fs_pre_sports.sport_code 'GOLF', or racing fs_pre_horse_racing_sports.sport_code 'HR')
 *   - datetime:   YYYYMMDDHHMM (competitions use 0000 for time)
 *   - country:    country_code from fs_pre_horse_racing_competitions (e.g. 'USA')
 *   - venue:      slugified canonical venue_name (e.g. 'charles_town')
 *   - horse:      slugified participant display_name / slug (e.g. 'senorita_jerico')
 */

/**
 * Slugify a string: lowercase, replace non-alphanumeric with underscores,
 * collapse multiple underscores, trim leading/trailing underscores.
 */
export function slugify(value: string): string {
    if (!value) return '';
    return value
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, '_')   // replace non-alphanumeric runs with _
        .replace(/^_+|_+$/g, '');        // trim leading/trailing underscores
}

/**
 * Format a Date to YYYYMMDDHHMM string in UTC.
 */
export function formatDateTime(date: Date): string {
    const y = date.getUTCFullYear();
    const m = String(date.getUTCMonth() + 1).padStart(2, '0');
    const d = String(date.getUTCDate()).padStart(2, '0');
    const h = String(date.getUTCHours()).padStart(2, '0');
    const min = String(date.getUTCMinutes()).padStart(2, '0');
    return `${y}${m}${d}${h}${min}`;
}

/**
 * Format a date string (YYYY-MM-DD) to YYYYMMDD0000 (competition-level, no time).
 */
export function formatDateOnly(day: string): string {
    // day is "YYYY-MM-DD"
    const cleaned = day.replace(/-/g, '');
    return `${cleaned}0000`;
}

/**
 * Build competition ref_id:
 *   Horse racing: HR.202603050000.USA.charles_town  (venue-based)
 *   Golf:         GOLF.202603250000.UNK.the_masters (competition-name-based)
 */
export function buildCompetitionRefId(
    sportCode: string,
    day: string,
    countryCode: string | null,
    identifyingName: string
): string {
    const parts = [
        sportCode,
        formatDateOnly(day),
        (countryCode || 'UNK').toUpperCase(),
        slugify(identifyingName)
    ];
    return parts.join('.');
}

/**
 * Build event ref_id:
 *   HR.202603051700.USA.charles_town
 */
export function buildEventRefId(
    sportCode: string,
    eventStartTime: Date,
    countryCode: string | null,
    venueName: string
): string {
    const parts = [
        sportCode,
        formatDateTime(eventStartTime),
        (countryCode || 'UNK').toUpperCase(),
        slugify(venueName)
    ];
    return parts.join('.');
}

/**
 * Extract the horse name from a value that might be a provider ref_id.
 * Detects provider ref_id formats (starting with digits and dots, e.g. Unibet's
 * "202603051900.T.GBR.newcastle.6.castan") and extracts the last segment.
 * Normal names like "Lion's House" or slugs like "lions-house" are returned as-is.
 */
export function extractParticipantName(value: string): string {
    if (!value) return '';
    // Detect provider ref_id format: starts with digits followed by a dot
    // e.g. "202603051900.T.GBR.newcastle.6.castan"
    // Normal display names like "Lion's House" or slugs like "lions-house" won't match
    if (/^\d+\./.test(value)) {
        const segments = value.split('.');
        return segments[segments.length - 1] || value;
    }
    return value;
}

/**
 * Build participant ref_id:
 *   HR.202603051700.USA.charles_town.senorita_jerico
 */
export function buildParticipantRefId(
    eventRefId: string,
    participantName: string
): string {
    return `${eventRefId}.${slugify(participantName)}`;
}

/** Max length for fs_pre_event_entries.entry_ref_id (varchar 255). */
export const PRE_EVENT_ENTRY_REF_ID_MAX_LEN = 255;

/**
 * Canonical `fs_pre_event_entries.entry_ref_id`: extends the pre-event ref with the runner segment,
 * same dot-separated style as `fs_pre_events.event_ref_id` / `fs_pre_event_groups.group_ref_id`.
 *
 * Example: `GOLF.202605170900.UNK.uspga_championship` + Brooks Koepka ->
 * `GOLF.202605170900.UNK.uspga_championship.brookskoepka`
 */
export function buildPreEventEntryRefId(eventRefId: string, participantDisplayOrName: string): string {
    return buildParticipantRefId(eventRefId, participantDisplayOrName).slice(0, PRE_EVENT_ENTRY_REF_ID_MAX_LEN);
}
