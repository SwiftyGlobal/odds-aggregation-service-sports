/**
 * Normalize golf outright / tournament titles for fuzzy matching only (not for display).
 *
 * - Trailing "presented by …" / "sponsored by …" (provider noise).
 * - Optional leading sponsor words (e.g. "JM Eagle LA Championship") when the remainder
 *   still looks like a tournament label. We avoid stripping "US" from "US Open" by
 *   refusing 2-letter all-caps prefixes when the remainder is a single short word, and
 *   by requiring tournament-like tails for short remainders.
 * - Year tokens and US PGA / USPGA → pga alignment (unchanged).
 *
 * Callers should pass the **original-casing** string when possible so leading-token
 * detection works; lowercase-only input skips leading sponsor stripping.
 */

const TRAILING_NOISE =
    /\s+((presented|sponsored)\s+by|in\s+association\s+with)\b[\s\S]*$/i;

function remainderLooksLikeTournamentCore(rest: string): boolean {
    const t = rest.trim();
    if (!t) return false;
    if (t.length >= 8) return true;

    const words = t.split(/\s+/).filter(Boolean);
    if (words.length >= 2 && t.length >= 6) return true;

    if (words.length === 1) {
        if (/^(championship|invitational|classic|masters|challenge|trophy)$/i.test(t)) {
            return t.length >= 6;
        }
        return t.length >= 8;
    }

    return false;
}

const LEADING_TOKEN = /^([A-Z][A-Za-z0-9&]*|[A-Z]{2,})\s+/;

/** Strip at most this many leading sponsor-style tokens. */
const MAX_LEADING_SPONSOR_TOKENS = 3;

function stripLeadingSponsorTokensPreservingCase(s: string): string {
    let current = s;
    for (let i = 0; i < MAX_LEADING_SPONSOR_TOKENS; i++) {
        const m = current.match(LEADING_TOKEN);
        if (!m || !m[1]) break;

        const token = m[1];
        const rest = current.slice(m[0].length).trim();
        if (!rest) break;

        if (token.length === 2 && /^[A-Z]{2}$/.test(token)) {
            const restWords = rest.split(/\s+/).filter(Boolean);
            if (restWords.length < 2) break;
        }

        if (!remainderLooksLikeTournamentCore(rest)) break;
        current = rest;
    }
    return current;
}

export function normalizeGolfEventTitleForMatching(name: string): string {
    let s = name.trim();
    s = s.replace(TRAILING_NOISE, '').trim();

    if (/[A-Z]/.test(s)) {
        s = stripLeadingSponsorTokensPreservingCase(s);
    }

    s = s.toLowerCase();
    s = s.replace(/\b20\d{2}\b/g, ' ');
    s = s.replace(/\b(u\.?s\.?\.?p\.?g\.?a\.?|uspga|us\s+pga)\b/gi, 'pga');
    s = s.replace(/\s+/g, ' ').trim();
    return s;
}
