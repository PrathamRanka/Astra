# Astra Architecture

Companion to [prd.md](./prd.md). Diagrams: see the Mermaid architecture page published alongside this repo (HLD, request flow, Governor, job states, DRR, fencing, ERD, k8s).

## 1. Principles

1. **Orchestrate, don't reinvent.** Redis and Postgres do the storage. Astra adds tenancy, fairness, safety and metering.
2. **One admission path.** Every primitive goes through the Governor.
3. **Atomic by construction.** Anything multi-step on hot data is a single Lua script.
4. **Stateless compute.** Gateways, workers and aggregators hold no durable state. Scheduler state lives in Redis.
5. **At-least-once everywhere, idempotency at the edges.**

## 2. Planes and services

| Plane | Component | Owns |
|---|---|---|
| Control | Postgres | orgs, projects, plans, api_keys, usage_rollups, job_history |
| Data | Redis | cache, queues, locks, rate buckets, quota counters, usage stream, scheduler state |
| Compute | gateway | Public API, auth, Governor, admin |
| Compute | scheduler | DRR dispatch, delayed promotion, lease reaper (leader-elected) |
| Compute | worker | Claims jobs, pushes to target URLs, ack/nack, heartbeat |
| Compute | aggregator | Consumes usage stream, writes hourly rollups |
| Client | sdk, cli | Developer-facing access |

**Data ownership.** Postgres is written only by `gateway` (admin, keys) and `aggregator` (rollups). Services never call each other over HTTP; they coordinate through Redis.

## 3. Request lifecycle

1. `request-id` middleware assigns `X-Request-Id`, starts an OTel span.
2. `auth` hashes the bearer key with sha256, looks it up (in-process LRU, 60 s TTL, then Postgres), and attaches `TenantContext`.
3. `governor` runs `governor_admit.lua`. Denied requests return `429`.
4. The route calls the primitive, which runs its own Lua script(s).
5. The response is sent. A usage event is `XADD`ed to `usage.events` after the response.

```ts
interface TenantContext { orgId: string; projectId: string; planId: string; keyId: string; limits: PlanLimits }
interface PlanLimits { weight: number; rps: number; maxConcurrency: number; maxBacklog: number; memBytes: number; opsPerDay: number }
type AdmitResult =
  | { ok: true }
  | { ok: false; reason: "RATE" | "QUOTA" | "BACKLOG"; retryAfterMs: number };
```

## 4. Tenant Governor

`governor_admit.lua` runs three checks in one atomic call, in order:

1. **Rate.** Token bucket at `rl:{pid}:{op}`.
2. **Quota.** Counters at `quota:{pid}:{metric}` for memory, in-flight jobs and ops per day.
3. **Backlog.** Queue length versus `plan.maxBacklog`.

First failure returns `DENY(reason, retryAfterMs)`. The same plan `weight` drives the DRR scheduler, so one config controls both admission and dispatch share.

Plan tiers are rows in `plans`, for example free (weight 1), pro (4), scale (10).

## 5. Primitive semantics

### Cache
- `get` hit and fresh: return value.
- Soft-expired: with probability `1 - exp(-delta * beta / ttl)` one caller wins `cl:{pid}:{key}` (SET NX PX) and refreshes. Others receive the stale value.
- Miss: one caller wins the loader lock; others wait (poll with jitter, bounded). Loader failure releases the lock and surfaces the error.
- Per-project memory accounted in `quota:{pid}:mem`; over quota returns `QUOTA`.

### Queue
Job lifecycle: `delayed → ready → inflight → succeeded`, with `inflight → ready` on nack or lease expiry, and `inflight → dead` when attempts run out.

- **Enqueue** (`queue_enqueue.lua`): checks `idem:{pid}:{key}` and either returns the existing job ID or writes the job hash and adds it to `ready` or `delayed`, all atomically.
- **Dispatch** (scheduler, DRR): per active tenant, `deficit += quantum * weight`; claim jobs while `deficit >= jobCost` and in-flight is under `maxConcurrency`; reset deficit when the tenant queue empties.
- **Claim** (`queue_claim.lua`): moves a job from `ready` to `inflight` with score = lease expiry.
- **Ack / nack** (`queue_ack.lua`, `queue_nack.lua`): ack removes from `inflight`. Nack requeues with exponential backoff plus jitter, or moves to `dlq` when `attempts >= maxAttempts`.
- **Reaper** (`queue_reap.lua`): moves jobs whose lease expired back to `ready` (attempts incremented).
- **Guarantee:** at-least-once. Handlers must be idempotent. Enqueue idempotency is exactly-once per key for 24 h.

### Lock
- Acquire (`lock_acquire.lua`): if free or expired, set owner and expiry, `INCR lk:fence:{pid}:{name}`, return the token.
- Renew and release check the owner token so a stale holder cannot release a newer holder's lock.
- **Limitation, stated plainly:** Astra can issue fencing tokens, but only the protected resource can reject stale writes. The SDK's `withLock` passes the token to the callback, and docs show the storage-side check.

### Rate limiter
Token bucket in `rate_limit_take.lua`: refill from elapsed time, deduct cost, return `allowed`, `remaining`, `retryAfterMs`. Time comes from Redis `TIME`, not the client.

## 6. Redis key schema

`{pid}` is a hash tag so all keys of one tenant map to one slot if Redis Cluster is used later. v1 runs a single instance. Scheduler keys are global and would need a different approach on Cluster.

| Primitive | Key | Type | Notes |
|---|---|---|---|
| Rate | `rl:{pid}:{name}` | hash `{tokens, ts}` | bucket |
| Cache | `c:{pid}:{key}` | string + PX | value |
| Cache | `cm:{pid}:{key}` | hash `{softExp, hardExp}` | stampede metadata |
| Cache | `cl:{pid}:{key}` | string NX PX | loader / refresh lock |
| Queue | `q:{pid}:{queue}:ready` | zset | score = priority/runAt |
| Queue | `q:{pid}:{queue}:delayed` | zset | score = runAt |
| Queue | `q:{pid}:{queue}:inflight` | zset | score = lease expiry |
| Queue | `q:{pid}:{queue}:dlq` | list | dead jobs |
| Queue | `job:{pid}:{jobId}` | hash | payload, attempts, status |
| Queue | `idem:{pid}:{idemKey}` | string, TTL 24 h | jobId |
| Scheduler | `sched:active_tenants` | zset | tenants with work |
| Scheduler | `sched:deficit:{pid}` | string (int) | DRR deficit |
| Scheduler | `sched:leader` | string NX PX | leader lease |
| Lock | `lk:{pid}:{name}` | hash `{owner, token, exp}` | lock |
| Lock | `lk:fence:{pid}:{name}` | string (INCR) | monotonic token |
| Quota | `quota:{pid}:{metric}` | string (int) | counters |
| Metering | `usage.events` | stream | consumer group `aggregator` |

## 7. Postgres schema

```
orgs(id PK, name, created_at)
plans(id PK, name, weight, rps, max_concurrency, max_backlog, mem_bytes, ops_per_day)
projects(id PK, org_id FK, plan_id FK, name, created_at)
api_keys(id PK, project_id FK, prefix, key_hash UNIQUE, scopes[], revoked_at, last_used_at, created_at)
usage_rollups(project_id, op, bucket_hour, units, PK(project_id, op, bucket_hour))
job_history(id PK, project_id FK, queue, status, attempts, last_error, created_at, finished_at)
```

Indexes: `api_keys(key_hash)`, `usage_rollups(project_id, bucket_hour)`, `job_history(project_id, created_at DESC)`.

## 8. API surface

```
POST   /v1/cache/:key            GET /v1/cache/:key           DELETE /v1/cache/:key
POST   /v1/queues/:q/jobs        GET /v1/queues/:q/jobs/:id   POST /v1/queues/:q/jobs/:id/retry
POST   /v1/queues/:q/claim       POST /v1/jobs/:id/ack        POST /v1/jobs/:id/nack     POST /v1/jobs/:id/heartbeat
POST   /v1/locks/:name/acquire   POST /v1/locks/:name/release  POST /v1/locks/:name/renew
POST   /v1/ratelimit/:name/take
GET    /v1/usage
POST   /admin/projects           POST /admin/projects/:id/keys
GET    /metrics  /healthz  /readyz
```

Headers: `Authorization: Bearer`, `Idempotency-Key`, `X-Request-Id`. Responses may include `X-RateLimit-Remaining` and `Retry-After`. The OpenAPI spec is generated from the zod route definitions.

## 9. Failure modes

| Failure | Effect | Handling |
|---|---|---|
| Worker dies mid-job | Job stays in `inflight` | Lease expires, reaper requeues, attempts incremented. Handlers must be idempotent |
| Scheduler leader dies | Dispatch pauses | `sched:leader` TTL expires, standby acquires. Deficits live in Redis so fairness resumes |
| Gateway pod dies | In-flight requests fail | Stateless; k8s restarts. Clients retry with `Idempotency-Key` |
| Redis restarts | Possible loss of last writes | AOF `everysec`: up to about 1 s of writes can be lost. Documented limit of v1 |
| Postgres down | No new keys or admin changes | Auth LRU keeps known keys working for its TTL. Usage events accumulate in the stream and are consumed after recovery |
| Aggregator dies | Rollups lag | Consumer group keeps pending entries; a restarted consumer claims them with `XAUTOCLAIM` |
| Duplicate usage events | Slight overcount | Accepted in v1; dedupe by request ID in v2 |
| Lock holder pauses past TTL | Two clients believe they hold it | Fencing token lets the resource reject the stale writer |
| Tenant floods queue | Backlog grows | Governor returns `BACKLOG` denials; DRR keeps other tenants' share |

## 10. Security

- API keys: `sk_live_` + 32 random bytes, shown once, stored as sha256, with a short plaintext `prefix` for lookup and display.
- Scopes on keys (`cache`, `queue`, `lock`, `ratelimit`, `usage:read`).
- Admin routes need a separate `ADMIN_TOKEN`.
- Tenant isolation is logical (key namespace + Governor). It is not a security boundary against a Redis-level compromise.
- Webhook-style pushes are signed with HMAC-SHA256 over timestamp + body.
- No secrets or payloads in logs; log request ID, project ID, op, status.

## 11. Observability

Metrics: `Astra_requests_total{op,status}`, `Astra_governor_denied_total{reason}`, `Astra_queue_depth{project,queue}`, `Astra_job_latency_seconds`, `Astra_lease_expired_total`, `Astra_cache_hit_ratio`, `Astra_lock_contention_total`.
Tracing: OpenTelemetry, one trace per request, with Redis script calls as child spans. Logging: pino, JSON, request-scoped.

## 12. Deployment

Docker multi-stage images per service. Local: `docker-compose.yml`. Kubernetes (kind): gateway Deployment (3 replicas) + Service + Ingress, scheduler Deployment (2 replicas, leader-elected), worker Deployment (HPA 2 to 10), aggregator Deployment (1), Redis and Postgres StatefulSets, ConfigMap, Secret, Prometheus, Grafana.

## 13. Testing strategy

- Unit: pure logic (DRR math, backoff, key builders).
- Integration: each Lua script against a real Redis container; Postgres repos against a real Postgres.
- Concurrency: N parallel claimers never double-claim; N parallel enqueues with one idempotency key create one job.
- Chaos: kill workers, scheduler leader and gateways during a load test; assert no lost jobs and no double-held locks.
- Benchmark: k6 noisy-neighbor scenario, FIFO baseline vs Astra.

## 14. ADRs to write

1. Redis-only data plane for hot state, Postgres for control plane.
2. Deficit Round Robin versus strict priority queues.
3. Fencing tokens versus plain TTL locks.
4. At-least-once with idempotency versus attempting exactly-once.
5. Leader-elected scheduler versus sharded schedulers.