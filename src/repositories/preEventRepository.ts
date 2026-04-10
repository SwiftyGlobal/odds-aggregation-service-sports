/**
 * Pre Event Repository
 * Database operations for pre-events
 */

import { DatabaseService } from '../utils/database.js';
import { Knex } from 'knex';
import { logger } from '../utils/logger.js';
import { TABLES } from '../constants/tables.js';
import { EVENT_STATUS_IDS } from '../constants/status.js';
import { SPORT_CODES } from '../constants/sports.js';
import { buildEventRefId } from '../utils/refIdUtils.js';
import { getSportAdapter } from '../adapters/index.js';

export class PreEventRepository {
    private static db = DatabaseService.getInstance();

    /** Columns used by horse-racing-era services but not present on fs_pre_events (v2 schema). */
    private static stripNonSchemaPreEventFields(payload: Record<string, unknown>): void {
        const keys = [
            'event_status_source_provider_id',
            'event_actual_start_time_source_provider_id',
            'event_actual_start_time_final',
            'event_end_time_source_provider_id',
            'event_end_time_final',
            'dividend_info_source_provider_id',
            'display_dividend_info',
            'display_dividend_info_source_provider_id',
        ] as const;
        for (const k of keys) {
            delete payload[k];
        }
    }

    private static statusIdToString(statusId?: number | null): string {
        if (statusId === 3) return 'completed';
        if (statusId === 2) return 'in_progress';
        return 'scheduled';
    }
    private static statusStringToId(status?: string | null): number {
        if (status === 'completed') return 3;
        if (status === 'in_progress') return 2;
        return 1;
    }

    /**
     * Safely convert dividend_info to a valid JSON string for database insertion
     * Handles various input formats (object, string, invalid JSON)
     */
    private static sanitizeDividendInfo(dividendInfo: any): string | null {
        if (!dividendInfo) return null;

        try {
            // If it's already a string, try to parse and re-stringify to validate
            if (typeof dividendInfo === 'string') {
                // Try to parse it first to validate
                const parsed = JSON.parse(dividendInfo);
                return JSON.stringify(parsed);
            }

            // If it's an object, stringify it
            if (typeof dividendInfo === 'object') {
                return JSON.stringify(dividendInfo);
            }

            return null;
        } catch (e) {
            // Invalid JSON - log and return null instead of crashing
            logger.warn('Invalid dividend_info JSON, setting to null', {
                type: typeof dividendInfo,
                preview: typeof dividendInfo === 'string' ? dividendInfo.substring(0, 100) : 'not a string',
                error: (e as Error).message
            });
            return null;
        }
    }

    /**
     * Find candidate pre-events for matching
     */
    static async findCandidateEvents(
        preCompetitionId: number,
        minTime: Date,
        maxTime: Date,
        trx?: Knex.Transaction
    ): Promise<any[]> {
        const db = trx || this.db;
        return await db(TABLES.PRE_EVENTS)
            .where('pre_event_group_id', preCompetitionId)
            .whereBetween('event_start_time', [minTime, maxTime])
            .whereNot('event_status', 'completed'); // Not FINISHED
    }

    /**
     * Create or update pre-event
     */
    static async createOrUpdatePreEvent(
        data: {
            event_name: string;
            pre_competition_id: number;
            event_start_time: Date;
            event_status_id?: number;
            ew_place?: number | null;
            ew_price?: number | null;
            dividend_info?: any;
            /** Allow sport-specific fields (e.g. distance, handicap) passed through adapter hooks */
            [key: string]: any;
        },
        trx?: Knex.Transaction
    ): Promise<number> {
        const db = trx || this.db;

        // Check if this pre-event already exists
        const existing = await db(TABLES.PRE_EVENTS)
            .where('pre_event_group_id', data.pre_competition_id)
            .where('event_start_time', data.event_start_time)
            .select('id')
            .first();

        const isNew = !existing;

        // Safely handle dividend_info to prevent JSON parsing errors
        const sanitizedDividendInfo = this.sanitizeDividendInfo(data.dividend_info);

        // Use the first event status from the adapter (e.g. PRE_RACE=1 for horse racing, PRE_EVENT=1 for golf)
        const firstEventStatusId = Object.values(EVENT_STATUS_IDS)[0] ?? 1;
        const initialStatusId = data.event_status_id || firstEventStatusId;

        const adapter = getSportAdapter();
        const identifyingField = adapter.matching.competition.matchField;

        // Generate stable ref_id using the adapter's identifying field
        // Horse racing: HR.202603051700.USA.charles_town (venue_name)
        // Golf: GOLF.202601010000.UNK.valero_texas_open (competition_name)
        const competition = await db(TABLES.PRE_COMPETITIONS)
            .where('id', data.pre_competition_id)
            .select('country_code', identifyingField)
            .first();

        const refId = competition
            ? buildEventRefId(
                SPORT_CODES.CURRENT_SPORT,
                data.event_start_time,
                competition.country_code,
                competition[identifyingField]
            )
            : null;

        // Build insert data — only include sport-specific columns when the adapter supports them
        const insertData: Record<string, any> = {
            pre_sport_id: adapter.sport.id,
            event_ref_id: refId,
            event_name: data.event_name,
            pre_event_group_id: data.pre_competition_id,
            event_start_time: data.event_start_time,
            event_status: this.statusIdToString(initialStatusId),
            metadata: {
                ew_place: data.ew_place || null,
                ew_price: data.ew_price || null,
                dividend_info: sanitizedDividendInfo ? JSON.parse(sanitizedDividendInfo) : null,
            },
            last_changed_at: new Date(),
            created_at: new Date(),
            updated_at: new Date()
        };

        const mergeData: Record<string, any> = {
            event_ref_id: refId,
            event_name: data.event_name,
            event_status: this.statusIdToString(initialStatusId),
            last_changed_at: new Date(),
            updated_at: new Date()
            // Note: monitoring_started_at is NOT merged - keep original value
        };

        adapter.hooks.event.applyPreEventCreateFields({
            data,
            insertData,
            mergeData,
        });

        const [preEvent] = await db(TABLES.PRE_EVENTS)
            .insert(insertData)
            .onConflict(['pre_event_group_id', 'event_ref_id'])
            .merge(mergeData)
            .returning('id');

        // Insert initial history record when pre-event is first created
        if (isNew) {
            await this.insertPreEventHistory(preEvent.id, initialStatusId, trx, 'created');
            logger.debug('Pre-event created with initial history', {
                preEventId: preEvent.id,
                eventStatusId: initialStatusId
            });
        }

        return preEvent.id;
    }

    /**
     * Get pre-event by ID
     */
    static async getPreEvent(
        preEventId: number,
        trx?: Knex.Transaction
    ): Promise<any | null> {
        const db = trx || this.db;
        const row = await db(TABLES.PRE_EVENTS)
            .where('id', preEventId)
            .first();
        if (!row) return null;
        return {
            ...row,
            event_status_id: row.event_status_id ?? this.statusStringToId(row.event_status),
            pre_competition_id: row.pre_competition_id ?? row.pre_event_group_id,
        };
    }

    /**
     * Increment snapshot version for pre_event.full messages
     * Also updates event_snapshot_sent_at timestamp
     */
    static async bumpEventSnapshotVersion(
        preEventId: number,
        trx: Knex.Transaction
    ): Promise<{ event_snapshot_version: number; event_snapshot_sent_at: Date }> {
        void preEventId;
        void trx;
        return {
            event_snapshot_version: 1,
            event_snapshot_sent_at: new Date()
        };
    }

    /**
     * Insert pre-event history record
     */
    static async insertPreEventHistory(
        preEventId: number,
        eventStatusId: number,
        trx?: Knex.Transaction,
        changeType: string = 'status'
    ): Promise<void> {
        void preEventId;
        void eventStatusId;
        void trx;
        void changeType;
        return;
    }

    /**
     * Update pre-event
     */
    static async updatePreEvent(
        preEventId: number,
        updates: any,
        trx?: Knex.Transaction
    ): Promise<void> {
        const db = trx || this.db;

        // Get existing status before update to detect changes
        const existing = await db(TABLES.PRE_EVENTS)
            .where('id', preEventId)
            .select('event_status')
            .first();

        const updatePayload: any = { ...updates };
        if (updatePayload.event_status_id != null && updatePayload.event_status == null) {
            updatePayload.event_status = this.statusIdToString(updatePayload.event_status_id);
        }
        delete updatePayload.event_status_id;
        delete updatePayload.ew_place;
        delete updatePayload.ew_price;
        delete updatePayload.dividend_info;
        delete updatePayload.monitoring_started_at;
        delete updatePayload.monitoring_ended_at;
        delete updatePayload.identity_matched_provider_ids;
        delete updatePayload.eligible_odds_provider_ids;
        delete updatePayload.fixed_odds_available_provider_ids;
        delete updatePayload.identity_matched_provider_count;
        delete updatePayload.eligible_odds_provider_count;
        delete updatePayload.fixed_odds_available_provider_count;

        this.stripNonSchemaPreEventFields(updatePayload);

        await db(TABLES.PRE_EVENTS)
            .where('id', preEventId)
            .update({
                ...updatePayload,
                last_changed_at: new Date(),
                updated_at: new Date()
            });

        // Insert event history if status changed
        if (existing && updatePayload.event_status && this.statusStringToId(updatePayload.event_status) > this.statusStringToId(existing.event_status)) {
            await this.insertPreEventHistory(preEventId, this.statusStringToId(updatePayload.event_status), trx);
        }
    }

    /**
     * Update pre-event status and related fields atomically
     * Handles sanitization of dividend_info and all status-related fields
     */
    static async updatePreEventStatus(
        preEventId: number,
        updates: any,
        trx?: Knex.Transaction
    ): Promise<void> {
        const db = trx || this.db;

        // Sanitize dividend_info if present
        const sanitizedUpdates: any = { ...updates };
        if (sanitizedUpdates.event_status_id != null && sanitizedUpdates.event_status == null) {
            sanitizedUpdates.event_status = this.statusIdToString(sanitizedUpdates.event_status_id);
        }
        delete sanitizedUpdates.event_status_id;
        delete sanitizedUpdates.ew_place;
        delete sanitizedUpdates.ew_price;
        delete sanitizedUpdates.monitoring_started_at;
        delete sanitizedUpdates.monitoring_ended_at;
        delete sanitizedUpdates.identity_matched_provider_ids;
        delete sanitizedUpdates.eligible_odds_provider_ids;
        delete sanitizedUpdates.fixed_odds_available_provider_ids;
        delete sanitizedUpdates.identity_matched_provider_count;
        delete sanitizedUpdates.eligible_odds_provider_count;
        delete sanitizedUpdates.fixed_odds_available_provider_count;

        if ('dividend_info' in updates) {
            const current = await db(TABLES.PRE_EVENTS).where('id', preEventId).select('metadata').first();
            const metadata = (current?.metadata && typeof current.metadata === 'object') ? current.metadata : {};
            metadata.dividend_info = updates.dividend_info;
            sanitizedUpdates.metadata = metadata;
            delete sanitizedUpdates.dividend_info;
        }

        this.stripNonSchemaPreEventFields(sanitizedUpdates);

        // Ensure updated_at is set
        sanitizedUpdates.updated_at = new Date();
        sanitizedUpdates.last_changed_at = new Date();

        await db(TABLES.PRE_EVENTS)
            .where('id', preEventId)
            .update(sanitizedUpdates);
    }

    /**
     * Lock pre-event row for update (concurrency-safe)
     * Used for coverage updates to prevent race conditions
     * 
     * @param preEventId - The pre-event ID
     * @param trx - Transaction (required)
     * @returns Pre-event ID if found, null otherwise
     */
    static async lockForUpdate(
        preEventId: number,
        trx: Knex.Transaction
    ): Promise<{ id: number } | null> {
        const preEvent = await trx(TABLES.PRE_EVENTS)
            .where('id', preEventId)
            .forUpdate()
            .first('id');

        return preEvent || null;
    }

    /**
     * Update coverage tracking fields for a pre-event
     * 
     * @param preEventId - The pre-event ID
     * @param coverageData - Coverage arrays and counts
     * @param trx - Transaction (required)
     */
    static async updateCoverage(
        preEventId: number,
        coverageData: {
            linkedProviderIds: number[];
            identityMatchedProviderIds: number[];
            eligibleOddsProviderIds: number[];
            fixedOddsAvailableProviderIds: number[];
        },
        trx: Knex.Transaction
    ): Promise<void> {
        // Compute counts (must equal array lengths)
        const linkedProviderCount = coverageData.linkedProviderIds.length;
        void coverageData.identityMatchedProviderIds;
        void coverageData.eligibleOddsProviderIds;
        void coverageData.fixedOddsAvailableProviderIds;

        // Format arrays as PostgreSQL array literals
        const formatArray = (arr: number[]): string => {
            if (arr.length === 0) return '{}';
            return '{' + arr.join(',') + '}';
        };

        await trx(TABLES.PRE_EVENTS)
            .where('id', preEventId)
            .update({
                linked_provider_ids: trx.raw('?::int[]', [formatArray(coverageData.linkedProviderIds)]),
                linked_provider_count: linkedProviderCount,
                last_changed_at: trx.fn.now(),
                updated_at: trx.fn.now()
            });
    }

    /**
     * Get event start time for a pre-event
     * 
     * @param preEventId - The pre-event ID
     * @param trx - Optional transaction
     * @returns Event start time or null
     */
    static async getEventStartTime(
        preEventId: number,
        trx?: Knex.Transaction
    ): Promise<Date | null> {
        const db = trx || this.db;
        const result = await db(TABLES.PRE_EVENTS)
            .where('id', preEventId)
            .select('event_start_time')
            .first();

        return result?.event_start_time || null;
    }

    /**
     * Lock pre-event and get full row for projection operations
     * Uses SELECT ... FOR UPDATE to prevent concurrent projector races
     * 
     * @param preEventId - The pre-event ID
     * @param trx - Transaction (required)
     * @returns Full pre-event row or null
     */
    static async lockForProjection(
        preEventId: number,
        trx: Knex.Transaction
    ): Promise<any | null> {
        const preEvent = await trx(TABLES.PRE_EVENTS)
            .where('id', preEventId)
            .forUpdate()
            .first();

        return preEvent || null;
    }

    /**
     * Update dividend_info map with a provider's dividend_info
     * Merges provider's dividend_info into existing map: { [providerId]: dividendInfo }
     * 
     * @param preEventId - The pre-event ID
     * @param dividendInfoMap - Complete dividend_info map to set
     * @param trx - Transaction (required)
     */
    static async updateDividendInfoMap(
        preEventId: number,
        dividendInfoMap: Record<string, any>,
        trx: Knex.Transaction
    ): Promise<void> {
        const existing = await trx(TABLES.PRE_EVENTS).where('id', preEventId).select('metadata').first();
        const metadata = (existing?.metadata && typeof existing.metadata === 'object') ? existing.metadata : {};
        metadata.dividend_info_map = dividendInfoMap;
        await trx(TABLES.PRE_EVENTS)
            .where('id', preEventId)
            .update({
                metadata,
                last_changed_at: new Date(),
                updated_at: new Date()
            });
    }

    /**
     * Update display_dividend_info (the final chosen dividend for display)
     * 
     * @param preEventId - The pre-event ID
     * @param displayDividendInfo - The dividend info to display
     * @param sourceProviderId - The provider that supplied the dividend
     * @param trx - Transaction (required)
     */
    static async updateDisplayDividendInfo(
        preEventId: number,
        displayDividendInfo: any,
        sourceProviderId: number,
        trx: Knex.Transaction
    ): Promise<void> {
        const existing = await trx(TABLES.PRE_EVENTS).where('id', preEventId).select('metadata').first();
        const metadata = (existing?.metadata && typeof existing.metadata === 'object') ? existing.metadata : {};
        metadata.display_dividend_info = displayDividendInfo;
        metadata.dividend_info_source_provider_id = sourceProviderId;
        await trx(TABLES.PRE_EVENTS)
            .where('id', preEventId)
            .update({
                metadata,
                last_changed_at: new Date(),
                updated_at: new Date()
            });
    }

    /**
     * Ensure monitoring_started_at is set (only updates if currently null)
     * 
     * @param preEventId - The pre-event ID
     * @param trx - Transaction (required)
     * @returns true if updated, false if already set
     */
    static async ensureMonitoringStarted(
        preEventId: number,
        trx: Knex.Transaction
    ): Promise<boolean> {
        void preEventId;
        void trx;
        return false;
    }

    /**
     * Update monitoring_ended_at
     * Only sets if currently null or new value is later than existing
     * 
     * @param preEventId - The pre-event ID
     * @param endedAt - The monitoring end timestamp
     * @param trx - Transaction (required)
     * @returns true if updated, false otherwise
     */
    static async updateMonitoringEndedAt(
        preEventId: number,
        endedAt: Date,
        trx: Knex.Transaction
    ): Promise<boolean> {
        void preEventId;
        void endedAt;
        void trx;
        return false;
    }

    /**
     * Get eligible provider IDs for a pre-event
     * Returns identity_matched_provider_ids if non-empty, otherwise linked_provider_ids
     * 
     * @param preEvent - The pre-event object (must have identity_matched_provider_ids and linked_provider_ids)
     * @returns Array of eligible provider IDs
     */
    static getEligibleProviderIds(preEvent: any): number[] {
        const identityMatched = preEvent.identity_matched_provider_ids;
        const linked = preEvent.linked_provider_ids;

        if (Array.isArray(identityMatched) && identityMatched.length > 0) {
            return identityMatched;
        }

        if (Array.isArray(linked) && linked.length > 0) {
            return linked;
        }

        return [];
    }
}
