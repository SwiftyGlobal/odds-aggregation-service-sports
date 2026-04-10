/**
 * Statistics Repository
 * Database operations for statistics and health checks
 */

import { DatabaseService } from '../utils/database.js';
import { SyncStats } from '../types/index.js';
import { TABLES } from '../constants/tables.js';

export class StatisticsRepository {
    private static db = DatabaseService.getInstance();

    /**
     * Get sync statistics
     */
    static async getSyncStats(): Promise<SyncStats> {
        const stats = await this.db(TABLES.PRE_EVENTS)
            .select(
                this.db.raw('COUNT(*) as total_events'),
                this.db.raw("COUNT(CASE WHEN status != 'completed' THEN 1 END) as active_events"),
                this.db.raw("COUNT(CASE WHEN status = 'completed' THEN 1 END) as resulted_events")
            )
            .first();

        const participantStats = await this.db(TABLES.PRE_EVENT_PARTICIPANTS)
            .count('* as total_participants')
            .first();

        const oddsStats = await this.db(TABLES.PRE_ODDS)
            .select(
                this.db.raw('COUNT(*) as total_odds'),
                this.db.raw('COUNT(CASE WHEN active = true THEN 1 END) as active_odds'),
                this.db.raw('MAX(last_changed_at) as last_sync')
            )
            .first();

        return {
            totalEvents: parseInt(String(stats?.total_events || '0')) || 0,
            matchedEvents: parseInt(String(stats?.active_events || '0')) || 0,
            unmatchedEvents: parseInt(String(stats?.resulted_events || '0')) || 0,
            totalParticipants: parseInt(String(participantStats?.total_participants || '0')) || 0,
            matchedParticipants: parseInt(String(participantStats?.total_participants || '0')) || 0,
            totalOdds: parseInt(String(oddsStats?.total_odds || '0')) || 0,
            aggregatedOdds: parseInt(String(oddsStats?.active_odds || '0')) || 0,
            lastSync: oddsStats?.last_sync || null
        };
    }

    /**
     * Check if provider has recent data (within last 24 hours)
     */
    static async hasRecentProviderData(providerId: number, hoursAgo: number = 24): Promise<boolean> {
        const cutoffTime = new Date(Date.now() - hoursAgo * 60 * 60 * 1000);
        
        const recentData = await this.db(TABLES.PROVIDER_EVENTS)
            .where('provider_id', providerId)
            .where('updated_at', '>', cutoffTime)
            .count('* as count')
            .first();

        return (parseInt(String(recentData?.count || '0')) || 0) > 0;
    }
}

