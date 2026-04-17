/**
 * Pre Odds Repository
 * Database operations for pre-odds
 */

import { DatabaseService } from '../utils/database.js';
import { Knex } from 'knex';
import { logger } from '../utils/logger.js';
import { TABLES } from '../constants/tables.js';

export class PreOddsRepository {
    private static db = DatabaseService.getInstance();
    private static statusIdToString(statusId?: number | null): string {
        return statusId === 2 ? 'suspended' : 'active';
    }
    private static statusStringToId(status?: string | null): number {
        return status === 'suspended' ? 2 : 1;
    }

    /**
     * Get pre-odds by market and option key
     */
    static async getPreOdds(
        preMarketId: number,
        optionKey: string,
        trx?: Knex.Transaction
    ): Promise<any | null> {
        const db = trx || this.db;
        const row = await db(TABLES.PRE_ODDS)
            .where({
                pre_market_id: preMarketId,
                option_key: optionKey
            })
            .first();
        if (!row) return null;
        return {
            ...row,
            market_id: row.market_id ?? row.pre_market_id,
            event_id: row.event_id ?? row.pre_event_id,
            pre_event_participant_id: row.pre_event_participant_id ?? row.pre_event_entry_id ?? row.event_entry_id,
            average_odds: row.average_odds ?? row.price,
            odds_status_id: row.odds_status_id ?? this.statusStringToId(row.selection_status),
            active: row.active ?? (row.selection_status !== 'removed' && row.selection_status !== 'invalid'),
            provider_count: row.linked_provider_count ?? 0,
        };
    }

    /**
     * Get the last history record for a pre-odds ID
     */
    static async getLastPreOddsHistory(
        preOddsId: number,
        trx?: Knex.Transaction
    ): Promise<any | null> {
        const db = trx || this.db;
        const row = await db(TABLES.PRE_ODDS_HISTORY)
            .where('pre_selection_id', preOddsId)
            .orderBy('created_at', 'desc')
            .first();
        if (!row) return null;
        return {
            ...row,
            pre_odds_id: row.pre_selection_id,
            average_odds: row.average_odds ?? row.price,
            odds_status_id: row.odds_status_id ?? this.statusStringToId(row.selection_status),
            provider_odds: row.provider_odds ?? '{}',
            display_odds: row.display_odds ?? '{}',
            provider_count: row.linked_provider_count ?? 0,
        };
    }

    /**
     * Create or update pre-odds with JSONB merge and history tracking
     */
    static async createOrUpdatePreOdds(
        data: {
            pre_event_id: number;
            pre_market_id: number;
            option_key: string;
            /** Human-readable label; when omitted on merge, existing fs_pre_selections.display_name is kept. */
            display_name?: string;
            pre_event_participant_id?: number | null;
            average_odds?: number | null;
            provider_count: number;
            provider_odds: string; // JSON string
            display_odds: string; // JSON string
            display_odds_provider_ids: number[]; // Provider IDs included in average
            outlier_odds_provider_ids: number[]; // Provider IDs excluded as outliers
            active: boolean;
            odds_status_id?: number | null; // Optional - if not provided, will be calculated for backward compatibility
            last_updated: Date;
            last_changed_at?: Date;
        },
        trx?: Knex.Transaction
    ): Promise<any> {
        const db = trx || this.db;
        const existing = await this.getPreOdds(data.pre_market_id, data.option_key, trx);
        const isNew = !existing;
        const selectionStatus = data.active ? this.statusIdToString(data.odds_status_id) : 'removed';
        const lastChangedAt = data.last_changed_at ?? data.last_updated;
        const metadata = {
            provider_count: data.provider_count,
            provider_odds: data.provider_odds ? JSON.parse(data.provider_odds) : {},
            display_odds: data.display_odds ? JSON.parse(data.display_odds) : {},
            display_odds_provider_ids: data.display_odds_provider_ids,
            outlier_odds_provider_ids: data.outlier_odds_provider_ids,
        };
        const providerPrices = metadata.provider_odds;
        const displayPrices = metadata.display_odds;
        const insertDisplayName = (data.display_name?.trim() || data.option_key) as string;

        // linked_provider_ids = all providers contributing a price to this selection
        // (those included in the average + those excluded as outliers).
        const linkedProviderIds = Array.from(
            new Set<number>([
                ...(data.display_odds_provider_ids ?? []),
                ...(data.outlier_odds_provider_ids ?? []),
            ])
        ).sort((a, b) => a - b);
        const formatArray = (arr: number[]): string => (arr.length === 0 ? '{}' : '{' + arr.join(',') + '}');

        const mergeFields: Record<string, unknown> = {
            pre_event_entry_id: data.pre_event_participant_id ?? null,
            current_price: data.average_odds,
            average_price: data.average_odds,
            linked_provider_count: data.provider_count ?? 0,
            linked_provider_ids: db.raw('?::int[]', [formatArray(linkedProviderIds)]),
            provider_prices: providerPrices,
            display_prices: displayPrices,
            selection_status: selectionStatus,
            active: data.active ?? true,
            last_changed_at: lastChangedAt,
            updated_at: new Date(),
        };
        if (data.display_name !== undefined) {
            mergeFields.display_name = insertDisplayName;
        }

        const [preOdds] = await db(TABLES.PRE_ODDS)
            .insert({
                pre_market_id: data.pre_market_id,
                pre_event_id: data.pre_event_id,
                pre_event_entry_id: data.pre_event_participant_id ?? null,
                selection_ref_id: `${data.pre_market_id}:${data.option_key}`,
                option_key: data.option_key,
                display_name: insertDisplayName,
                opening_price: data.average_odds,
                current_price: data.average_odds,
                average_price: data.average_odds,
                linked_provider_count: data.provider_count ?? 0,
                linked_provider_ids: db.raw('?::int[]', [formatArray(linkedProviderIds)]),
                provider_prices: providerPrices,
                display_prices: displayPrices,
                selection_status: selectionStatus,
                selection_outcome: 'pending',
                active: data.active ?? true,
                last_changed_at: lastChangedAt,
                created_at: new Date(),
                updated_at: new Date(),
            })
            .onConflict(['pre_market_id', 'option_key'])
            .merge(mergeFields)
            .returning('*');

        await db(TABLES.PRE_ODDS_HISTORY).insert({
            pre_selection_id: preOdds.id,
            pre_event_id: data.pre_event_id,
            price: preOdds.current_price,
            average_price: preOdds.average_price,
            linked_provider_count: preOdds.linked_provider_count,
            provider_prices: preOdds.provider_prices,
            display_prices: preOdds.display_prices,
            selection_status: preOdds.selection_status,
            selection_outcome: preOdds.selection_outcome,
            recorded_at: new Date(),
            created_at: new Date(),
        });

        return {
            ...preOdds,
            market_id: preOdds.pre_market_id,
            event_id: preOdds.pre_event_id,
            pre_event_participant_id: preOdds.pre_event_entry_id,
            average_odds: preOdds.average_price,
            odds_status_id: this.statusStringToId(preOdds.selection_status),
            change_type: isNew ? 'created' : 'updated',
            is_new: isNew,
        };
    }

    /**
     * Get all pre-odds for an event
     */
    static async getPreOddsByEvent(
        preEventId: number,
        trx?: Knex.Transaction
    ): Promise<any[]> {
        const db = trx || this.db;
        const rows = await db(TABLES.PRE_ODDS)
            .where('pre_event_id', preEventId)
            .whereIn('selection_status', ['active', 'suspended']);
        return rows.map((row: any) => ({
            ...row,
            event_id: row.pre_event_id,
            market_id: row.pre_market_id,
            pre_event_participant_id: row.pre_event_entry_id,
            average_odds: row.price,
            active: row.selection_status !== 'removed' && row.selection_status !== 'invalid',
            odds_status_id: this.statusStringToId(row.selection_status),
            provider_count: row.linked_provider_count ?? 0,
        }));
    }

    /**
     * Get all pre-odds for an event (including inactive)
     */
    static async getAllPreOddsByEvent(
        preEventId: number,
        trx?: Knex.Transaction
    ): Promise<any[]> {
        const db = trx || this.db;
        const rows = await db(TABLES.PRE_ODDS)
            .where('pre_event_id', preEventId);
        return rows.map((row: any) => ({
            ...row,
            event_id: row.pre_event_id,
            market_id: row.pre_market_id,
            pre_event_participant_id: row.pre_event_entry_id,
            average_odds: row.price,
            active: row.selection_status !== 'removed' && row.selection_status !== 'invalid',
            odds_status_id: this.statusStringToId(row.selection_status),
            provider_count: row.linked_provider_count ?? 0,
        }));
    }
}
