/**
 * Pre Event Outbox Service
 * Emits full event snapshots to the outbox table.
 */

import { Knex } from 'knex';
import { logger } from '../utils/logger.js';
import { PreEventRepository } from '../repositories/preEventRepository.js';
import { PreCompetitionRepository } from '../repositories/preCompetitionRepository.js';
import { PreEventParticipantRepository } from '../repositories/preEventParticipantRepository.js';
import { PreOddsRepository } from '../repositories/preOddsRepository.js';
import { EventParticipantRepository } from '../repositories/eventParticipantRepository.js';
import { OutboxRepository } from '../repositories/outboxRepository.js';
import { OUTBOX_EVENT_TYPES } from '../constants/outbox.js';
import { buildPreEventFullPayload, buildPreOddsDeltaPayload, buildSelectionKey } from '../utils/outboxPayloadBuilder.js';

const FULL_EVENT_INTERVAL_MINUTES = parseInt(process.env.PRE_EVENT_FULL_INTERVAL_MINUTES || '10', 10);

export class PreEventOutboxService {
    /**
     * Emit a full event snapshot if needed.
     * - force=true: always emit
     * - force=false: emit if first time or older than interval
     */
    static async emitIfNeeded(
        preEventId: number,
        trx: Knex.Transaction,
        options?: { force?: boolean }
    ): Promise<void> {
        const force = options?.force === true;

        const preEvent = await PreEventRepository.getPreEvent(preEventId, trx);
        if (!preEvent) {
            return;
        }

        const lastSentAt = preEvent.event_snapshot_sent_at
            ? new Date(preEvent.event_snapshot_sent_at)
            : null;

        if (!force && lastSentAt) {
            const ageMs = Date.now() - lastSentAt.getTime();
            const intervalMs = FULL_EVENT_INTERVAL_MINUTES * 60 * 1000;
            if (ageMs < intervalMs) {
                return;
            }
        }

        const eligibleProviderIds = PreEventRepository.getEligibleProviderIds(preEvent);
        if (eligibleProviderIds.length === 0) {
            logger.debug('Pre-event full snapshot skipped (no eligible providers)', { preEventId });
            return;
        }

        const matchCounts = await EventParticipantRepository.getProviderParticipantMatchCounts(
            preEventId,
            eligibleProviderIds,
            trx
        );

        if (matchCounts.total === 0) {
            logger.debug('Pre-event full snapshot skipped (no participants yet)', { preEventId });
            return;
        }

        if (matchCounts.matched < matchCounts.total) {
            logger.debug('Pre-event full snapshot skipped (participants not fully matched)', {
                preEventId,
                matched: matchCounts.matched,
                total: matchCounts.total
            });
            return;
        }

        const preCompetition = preEvent.event_group_id
            ? await PreCompetitionRepository.getPreCompetition(preEvent.event_group_id, trx)
            : null;

        const participants = await PreEventParticipantRepository.getByPreEventId(preEventId, trx);

        const snapshot = await PreEventRepository.bumpEventSnapshotVersion(preEventId, trx);
        const payload = buildPreEventFullPayload({
            preEvent: {
                ...preEvent,
                event_snapshot_sent_at: snapshot.event_snapshot_sent_at
            },
            preCompetition,
            participants,
            version: snapshot.event_snapshot_version
        });

        await OutboxRepository.insertOutboxEvent(
            {
                event_type: OUTBOX_EVENT_TYPES.PRE_EVENT_FULL,
                aggregate_key: String(preEventId),
                payload,
                version: snapshot.event_snapshot_version
            },
            trx
        );

        if (snapshot.event_snapshot_version === 1) {
            const preOddsRows = await PreOddsRepository.getAllPreOddsByEvent(preEventId, trx);
            for (const preOdds of preOddsRows) {
                const selectionKey = buildSelectionKey(
                    preOdds.market_id,
                    preOdds.option_key
                );

                const oddsPayload = buildPreOddsDeltaPayload({
                    preOdds,
                    selectionKey
                });

                await OutboxRepository.insertOutboxEvent(
                    {
                        event_type: OUTBOX_EVENT_TYPES.PRE_ODDS_DELTA,
                        aggregate_key: selectionKey,
                        payload: oddsPayload,
                        version: preOdds.version ?? 1
                    },
                    trx
                );
            }
        }

        logger.debug('Pre-event full snapshot emitted', {
            preEventId,
            version: snapshot.event_snapshot_version
        });
    }
}
