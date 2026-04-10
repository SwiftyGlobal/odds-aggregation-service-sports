/**
 * Error Classification Utility
 * Distinguishes transient errors (worth retrying) from permanent errors
 */

// PostgreSQL error codes that are transient (connection/resource issues)
const TRANSIENT_PG_CODES = new Set([
    '08000', // connection_exception
    '08003', // connection_does_not_exist
    '08006', // connection_failure
    '40001', // serialization_failure
    '40P01', // deadlock_detected
    '53000', // insufficient_resources
    '53100', // disk_full
    '53200', // out_of_memory
    '53300', // too_many_connections
    '55P03', // lock_not_available
    '57P01', // admin_shutdown
    '57P02', // crash_shutdown
    '57P03', // cannot_connect_now
    '57014', // query_canceled (timeout)
]);

// Error message patterns that indicate transient issues
const TRANSIENT_MESSAGE_PATTERNS = [
    /connection (terminated|refused|reset|timed out)/i,
    /timeout/i,
    /deadlock/i,
    /could not (connect|obtain)/i,
    /too many connections/i,
    /remaining connection slots are reserved/i,
    /connection pool/i,
    /ECONNREFUSED/i,
    /ECONNRESET/i,
    /ETIMEDOUT/i,
    /KnexTimeoutError/i,
];

/**
 * Determines if an error is transient and worth retrying.
 * Returns true for connection issues, deadlocks, timeouts, pool exhaustion.
 * Returns false for data integrity violations, syntax errors, missing tables, etc.
 */
export function isTransientError(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;

    const err = error as Record<string, any>;

    // Check PostgreSQL error code
    if (err.code && TRANSIENT_PG_CODES.has(err.code)) {
        return true;
    }

    // Check error message patterns
    const message = err.message || '';
    for (const pattern of TRANSIENT_MESSAGE_PATTERNS) {
        if (pattern.test(message)) {
            return true;
        }
    }

    return false;
}

/**
 * Extracts a short error code string for logging/storage
 */
export function getErrorCode(error: unknown): string {
    if (!error || typeof error !== 'object') return 'UNKNOWN';

    const err = error as Record<string, any>;

    if (err.code) return String(err.code);
    if (err.name) return String(err.name);

    return 'UNKNOWN';
}
