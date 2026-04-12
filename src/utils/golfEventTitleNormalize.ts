/**
 * Normalize golf outright titles for fuzzy matching only (not for display).
 * Aligns US PGA / USPGA naming with generic "PGA Championship" style labels.
 */
export function normalizeGolfEventTitleForMatching(name: string): string {
    let s = name.trim().toLowerCase();
    s = s.replace(/\b20\d{2}\b/g, ' ');
    s = s.replace(/\b(u\.?s\.?\.?p\.?g\.?a\.?|uspga|us\s+pga)\b/gi, 'pga');
    s = s.replace(/\s+/g, ' ').trim();
    return s;
}
