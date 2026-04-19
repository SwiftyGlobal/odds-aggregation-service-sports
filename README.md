# odds-aggregation-service-sports

Aggregation service for non-racing sports (golf, basketball, …). Targets **feed-sports-db** — the canonical `fs_pre_*` + generic `fs_provider_*` schema.

Horse-racing / greyhounds use **odds-aggregation-service-racing** against **feed-racing-db**.

---

## How it works

1. **Polling** — `PollingService` polls configured `fs_provider_*` tables every N ms for rows with `updated_at > cursor`.
2. **Change processing** — `PollingChangeProcessor` routes each changed row through the correct matching / aggregation pipeline.
3. **Matching** — provider events/participants/markets are matched to canonical `fs_pre_*` rows using name similarity, time windows, and overlap thresholds (all tunable per adapter).
4. **Aggregation** — matched odds are written to `fs_pre_selections` / `fs_pre_selection_price_history`.
5. **Outbox** — meaningful changes emit sport-prefixed events (`golf.pre_event.full`, `golf.pre_odds.delta`) into `fs_outbox_events`.  `event-publisher-service-sports` picks these up and routes them to Kafka topic `fs_sports.<event_type>`.
6. **Cursor persistence** — after each poll batch, the cursor `(sport_id, table_name)` is upserted into `fs_agg_polling_cursors` so restarts are safe.

---

## Sport adapter pattern

All sport-specific config lives in `src/adapters/<sport>/index.ts`. The runtime selects the adapter via the `SPORT_ADAPTER` env var:

```
SPORT_ADAPTER=golf npm run start
```

Each adapter defines:
- **`sport`** — `id`, `code`, `name` (must match DB `provider_sport_id`)
- **`tables`** — concrete table name map (`fs_provider_events` → `fs_pre_events`, etc.)
- **`polling.tables`** — which tables to poll
- **`polling.sportScope`** — per-table Knex subquery builders that scope polling to this sport's rows only (required for safe multi-sport sharing of the same DB)
- **`polling.orderByIdColumn`** — tie-break column per table (default: `id`)
- **`matching`** — eventGroup / event / participant thresholds
- **`providers`** — provider list with health-check flags
- **`eventStatus` / `oddsStatus`** — numeric status mappings
- **`marketTypes`** — market type name map
- **`hooks`** — `participant`, `event`, `odds`, `projection`, `metadata` hooks for sport-specific field handling

### Registered adapters

| Key | Sport | `sport.id` |
|-----|-------|-----------|
| `golf` | Golf | 2 |
| _(basketball coming)_ | Basketball | TBD |

To add a new sport: create `src/adapters/<sport>/index.ts`, implement `SportAdapter`, register it in `src/adapters/registry.ts`.

---

## Per-sport ECS deployment

One Docker image. One ECS task definition + service per sport, differentiated only by env var:

| ECS Service | `SPORT_ADAPTER` |
|---|---|
| `odds-agg-sports-golf` | `golf` |
| `odds-agg-sports-basketball` | `basketball` |

Polling cursors are keyed `(sport_id, table_name)` so two tasks running against the same DB never collide.

Outbox events are keyed `golf.pre_event.full`, `basketball.pre_odds.delta`, etc., so the single `event-publisher-service-sports` and `feed-go-gateway` downstream need no changes when a new sport is added — just deploy the new aggregation task and add its Kafka topics to the gateway's `KAFKA_TOPICS`.

---

## Project structure

```
src/
├── adapters/
│   ├── golf/index.ts          # Golf adapter (sport id 2)
│   ├── registry.ts            # SPORT_ADAPTER → adapter lookup
│   └── types.ts               # SportAdapter interface + all sub-types
├── config/                    # Env-driven config (DB pool, log level, …)
├── constants/
│   └── outbox.ts              # Sport-prefixed OUTBOX_EVENT_TYPES (set at boot)
├── repositories/
│   ├── pollingRepository.ts   # getChangedRows (sport-scoped), cursor upsert/load
│   ├── outboxRepository.ts
│   ├── preEventRepository.ts
│   ├── preOddsRepository.ts
│   └── …
├── services/
│   ├── pollingService.ts          # Main poll loop
│   ├── pollingChangeProcessor.ts  # Routes changed rows to pipelines
│   ├── aggregationService.ts
│   ├── realTimeAggregationService.ts
│   ├── preEventOutboxService.ts   # Writes sport-prefixed outbox events
│   ├── preEventProjectionService.ts
│   ├── oddsAggregationService.ts
│   ├── oddsProcessingService.ts
│   ├── eventMatchingService.ts
│   ├── eventGroupMatchingService.ts
│   ├── eventParticipantMatchingService.ts
│   ├── marketMatchingService.ts
│   └── …
├── matchers/
├── types/
└── utils/
index.ts                       # Entry point — boots adapter then polling loop
```

---

## Commands

```bash
# Run the service (adapter must be set)
SPORT_ADAPTER=golf npm run start

# Pre-layer sync stats
SPORT_ADAPTER=golf npm run sync:pre

# Health check
SPORT_ADAPTER=golf npm run health
```

---

## Environment variables

| Variable | Description | Default |
|---|---|---|
| `SPORT_ADAPTER` | Which sport adapter to load (`golf`, `basketball`, …) | **required** |
| `DB_HOST` | PostgreSQL host | `localhost` |
| `DB_PORT` | PostgreSQL port | `5432` |
| `DB_NAME` | Database name | `feed_sports_db` |
| `DB_USER` | Database user | `postgres` |
| `DB_PASSWORD` | Database password | — |
| `PG_SSL` | Enable SSL | `false` |
| `PG_POOL_MIN` | Connection pool min | `0` |
| `PG_POOL_MAX` | Connection pool max | `10` |
| `LOG_LEVEL` | Log level | `info` |
| `LOG_FORMAT` | `json` or `pretty` | `json` |

Health-check flags per provider (example for golf):

| Variable | Default |
|---|---|
| `HEALTH_CHECK_UNIBET_ENABLED` | `true` |
| `HEALTH_CHECK_CORAL_ENABLED` | `true` |
| `HEALTH_CHECK_888SPORT_ENABLED` | `true` |
| `HEALTH_CHECK_NETBET_ENABLED` | `true` |

---

## Production deployment (golf example)

```bash
# Build
docker build --no-cache -t odds-aggregation-service-sports-golf:local .

# Tag
TAG=dev-$(date +%Y%m%d-%H%M%S)
ECR_IMAGE="767723246354.dkr.ecr.eu-west-1.amazonaws.com/swiftyfeeds/odds-aggregation-service-sports-golf:${TAG}"
docker tag odds-aggregation-service-sports-golf:local "$ECR_IMAGE"

# Login
aws --profile swifty --region eu-west-1 ecr get-login-password \
  | docker login --username AWS --password-stdin 767723246354.dkr.ecr.eu-west-1.amazonaws.com

# Push
docker push "$ECR_IMAGE"
```

ECS task definition env vars to set:
```
SPORT_ADAPTER=golf
DB_HOST=<feed-sports-db RDS endpoint>
DB_NAME=feed_sports_db
...
```

## Production

for golf should be used "-golf" postfix

#### build
    docker build --no-cache -t odds-aggregation-service-sports-golf:local .
#### choose a new tag
    TAG=dev-$(date +%Y%m%d-%H%M%S)
#### tag for ECR
    [1] ECR_IMAGE="767723246354.dkr.ecr.eu-west-1.amazonaws.com/swiftyfeeds/odds-aggregation-service-sports-golf:${TAG}"
    [2] docker tag odds-aggregation-service-sports-golf:local "$ECR_IMAGE"
#### login to aws
    aws --profile swifty --region eu-west-1 ecr get-login-password \
  | docker login --username AWS --password-stdin 767723246354.dkr.ecr.eu-west-1.amazonaws.com
#### push
    docker push "$ECR_IMAGE"