# Substrate

**Distributed primitives as one multi-tenant platform.** Cache, queue, lock and rate limiter behind one API key, one SDK, and one Tenant Governor that keeps a noisy tenant from starving everyone else.

> Status: design phase. Docs are written first, code follows. See [docs/](./docs).

## Why

Backends stitch together Redis caching, BullMQ, Redlock, cron and a rate limiter. None of them know about each other, and none of them know which tenant is hammering the box. Substrate runs these primitives behind one gateway and puts a shared governor in front of all of them:

- **Fair scheduling.** Per-tenant queues dispatched with Deficit Round Robin, weighted by plan tier.
- **Safe locks.** TTL leases with fencing tokens, so a paused client cannot corrupt state.
- **Stampede-proof cache.** Request coalescing and early probabilistic refresh.
- **One admission check.** Rate, quota and backlog limits enforced atomically in Redis Lua, answered with `429` + `Retry-After`.
- **Metering from day one.** Every operation emits a usage event, the foundation for billing later.

## Primitives

| Primitive | What it gives you | Key mechanism |
|---|---|---|
| Cache | `get/set/delete` with stampede protection | Coalescing lock + soft/hard expiry |
| Queue | Jobs with retries, delays, DLQ, idempotency | DRR scheduler, leases, reaper |
| Lock | Distributed mutex | TTL lease + monotonic fencing token |
| Rate limiter | Standalone `take()` API | Token bucket in Lua |

Stretch: cron, pub/sub. Roadmap: billing, managed Postgres, RBAC, multi-region.

## Architecture at a glance

```
 SDK / CLI / REST
        │  Bearer sk_live_...
        ▼
 ┌────────────────────┐        ┌──────────────┐
 │ gateway (Hono) xN  │───────►│  Postgres    │ control plane
 │ auth → governor →  │        │  orgs, keys, │
 │ primitive routes   │        │  plans, usage│
 └─────────┬──────────┘        └──────▲───────┘
           │ EVALSHA Lua               │ hourly upsert
           ▼                           │
 ┌────────────────────┐        ┌───────┴──────┐
 │ Redis (data plane) │◄───────│ aggregator   │
 │ cache, queues,     │ stream └──────────────┘
 │ locks, buckets     │
 └───▲────────────▲───┘
     │            │
 ┌───┴─────┐  ┌───┴────┐
 │scheduler│  │ worker │
 │ DRR     │  │ push   │
 │ reaper  │  │ deliver│
 └─────────┘  └────────┘
```

Full diagrams and design: [docs/architecture.md](./docs/architecture.md).

## Quickstart

Requirements: Node 24, pnpm 9+, Docker, kind, kubectl.

```bash
# local, docker compose
cp .env.example .env
make up            # redis, postgres, all four services
make migrate       # apply Postgres migrations
make seed          # creates demo org, project, API key (printed once)

# local Kubernetes (kind)
make kind-up       # create cluster
make k8s-apply     # build images, load into kind, apply manifests
make k8s-forward   # gateway on http://localhost:8080
```

## Using it

```ts
import { Substrate } from "@substrate/sdk";

const s = new Substrate({ apiKey: process.env.SUBSTRATE_KEY! });

// cache with stampede protection
const user = await s.cache.getOrLoad("user:42", () => db.getUser(42), { ttlMs: 60_000 });

// fair queue with idempotency
await s.queue("emails").enqueue({ to: "a@b.com" }, { idempotencyKey: "welcome-42", maxAttempts: 5 });

// lock with fencing token
await s.lock("order-42").withLock({ ttlMs: 10_000 }, async ({ token }) => {
  await storage.write(order, { fencingToken: token });
});

// rate limiter
const { allowed, retryAfterMs } = await s.ratelimit("login:1.2.3.4").take();
```

## Repository layout

Server code lives in `apps/`, client code in `clients/`, shared code in `packages/`. Each service is its own deployable with its own `package.json`, `Dockerfile` and env schema.

```
substrate/
├─ apps/                                   SERVER: one folder = one deployable
│  ├─ gateway/                             public HTTP API, port 8080
│  │  ├─ src/
│  │  │  ├─ server.ts                      process entry, graceful shutdown
│  │  │  ├─ app.ts                         builds the Hono app, mounts middleware + routes
│  │  │  ├─ config.ts                      zod-validated env
│  │  │  ├─ middleware/
│  │  │  │  ├─ request-id.ts               X-Request-Id + OTel span
│  │  │  │  ├─ auth.ts                     API key → TenantContext
│  │  │  │  ├─ governor.ts                 calls governor.admit(), maps DENY → 429
│  │  │  │  ├─ metrics.ts                  request counters/histograms
│  │  │  │  └─ error-handler.ts            typed errors → JSON problem responses
│  │  │  └─ routes/
│  │  │     ├─ cache.routes.ts
│  │  │     ├─ queue.routes.ts
│  │  │     ├─ lock.routes.ts
│  │  │     ├─ ratelimit.routes.ts
│  │  │     ├─ usage.routes.ts
│  │  │     ├─ admin.routes.ts             orgs, projects, keys (admin token only)
│  │  │     └─ health.routes.ts            /healthz /readyz /metrics
│  │  ├─ test/
│  │  ├─ Dockerfile
│  │  ├─ package.json
│  │  └─ tsconfig.json
│  ├─ scheduler/                           fair dispatch, port 8081 (metrics)
│  │  └─ src/
│  │     ├─ main.ts
│  │     ├─ config.ts
│  │     ├─ leader.ts                      Redis leader lease
│  │     ├─ drr.ts                         Deficit Round Robin loop
│  │     ├─ promoter.ts                    delayed → ready
│  │     └─ reaper.ts                      expired leases → ready / dead
│  ├─ worker/                              push delivery to job target URLs, port 8082
│  │  └─ src/
│  │     ├─ main.ts
│  │     ├─ config.ts
│  │     ├─ runner.ts                      claim → deliver → ack/nack
│  │     ├─ deliver.ts                     HTTP POST + HMAC signature
│  │     └─ heartbeat.ts                   lease renewal
│  └─ aggregator/                          usage metering, port 8083
│     └─ src/
│        ├─ main.ts
│        ├─ config.ts
│        ├─ consumer.ts                    XREADGROUP + XAUTOCLAIM
│        └─ rollup.ts                      hourly upserts into Postgres
│
├─ clients/                                CLIENT: what developers install
│  ├─ sdk/                                 @substrate/sdk
│  │  └─ src/
│  │     ├─ index.ts
│  │     ├─ client.ts                      fetch wrapper, retries, idempotency headers
│  │     ├─ errors.ts
│  │     ├─ cache.ts
│  │     ├─ queue.ts
│  │     ├─ lock.ts
│  │     └─ ratelimit.ts
│  ├─ cli/                                 @substrate/cli  (binary: substrate)
│  │  └─ src/
│  │     ├─ index.ts
│  │     └─ commands/                      login.ts, keys.ts, queues.ts, usage.ts
│  └─ dashboard/                           STRETCH: minimal web UI
│
├─ packages/                               SHARED: libraries, never deployed alone
│  ├─ core/                                @substrate/core
│  │  └─ src/ types.ts, errors.ts, ids.ts, logger.ts, env.ts
│  ├─ redis/                               @substrate/redis
│  │  └─ src/ client.ts, scripts.ts (EVALSHA loader), keys.ts (key builders)
│  │     lua/ governor_admit.lua, rate_limit_take.lua, cache_get_or_lock.lua,
│  │          queue_enqueue.lua, queue_claim.lua, queue_ack.lua, queue_nack.lua,
│  │          queue_reap.lua, lock_acquire.lua, lock_release.lua, lock_renew.lua
│  ├─ db/                                  @substrate/db
│  │  ├─ migrations/                       0001_init.sql, ...
│  │  └─ src/ client.ts, repos/ (projects.ts, api-keys.ts, plans.ts, usage.ts)
│  ├─ governor/                            @substrate/governor
│  │  └─ src/ admit.ts, plans.ts
│  ├─ primitives/                          @substrate/primitives
│  │  └─ src/ cache/, queue/, lock/, ratelimit/   (each: index.ts, types.ts)
│  └─ telemetry/                           @substrate/telemetry
│     └─ src/ metrics.ts, tracing.ts
│
├─ deploy/
│  ├─ docker/                              compose helpers, init scripts
│  ├─ kind/kind-config.yaml
│  ├─ k8s/                                 namespace.yaml, configmap.yaml, secrets.example.yaml,
│  │                                       gateway.yaml, scheduler.yaml, worker.yaml, aggregator.yaml,
│  │                                       redis.yaml, postgres.yaml, prometheus.yaml, grafana.yaml, ingress.yaml
│  └─ grafana/dashboards/
├─ bench/                                  k6 scripts: noisy-neighbor.js, stampede.js, lock-contention.js
├─ examples/                               noisy-neighbor-demo/, express-app/
├─ docs/                                   prd.md, architecture.md, redis-model.md, failure-table.md,
│                                          openapi.yaml, adr/
├─ .github/workflows/ci.yml
├─ docker-compose.yml  Makefile  pnpm-workspace.yaml  package.json
└─ tsconfig.base.json  .env.example  LICENSE  CONTRIBUTING.md
```

### Dependency rules

1. `apps/*` and `clients/*` may import from `packages/*`. Never from each other.
2. `clients/*` import only `@substrate/core` types. They never import server code.
3. Services do not call each other over HTTP. They share state through Redis (keys and streams) and Postgres.
4. Only `gateway` (admin and auth) and `aggregator` (rollups) touch Postgres.

## Ports and env

| Service | Port | Purpose |
|---|---|---|
| gateway | 8080 | Public API, `/metrics` |
| scheduler | 8081 | `/metrics`, `/healthz` |
| worker | 8082 | `/metrics`, `/healthz` |
| aggregator | 8083 | `/metrics`, `/healthz` |
| redis | 6379 | Data plane |
| postgres | 5432 | Control plane |
| prometheus / grafana | 9090 / 3000 | Observability |

Shared env vars: `REDIS_URL`, `DATABASE_URL`, `LOG_LEVEL`, `OTEL_EXPORTER_OTLP_ENDPOINT`.
Service-specific: `PORT`, `ADMIN_TOKEN` (gateway), `SCHEDULER_TICK_MS`, `LEASE_MS`, `DRR_QUANTUM` (scheduler), `WORKER_CONCURRENCY` (worker).

## Naming conventions

- Files and folders: `kebab-case`. Route files end in `.routes.ts`, repos live in `repos/`.
- Lua scripts: `snake_case.lua`, named `<primitive>_<action>.lua`.
- Packages: `@substrate/<name>`.
- Redis keys: `<prefix>:{projectId}:<name>[:<part>]`. The braces are a hash tag so one tenant's keys share a cluster slot.
- Metrics: `substrate_<noun>_<unit>` e.g. `substrate_governor_denied_total`.
- Env vars: `UPPER_SNAKE_CASE`, validated with zod at startup.
- Commits: Conventional Commits (`feat(queue): ...`).

## Docs

| Doc | What it answers |
|---|---|
| [docs/prd.md](./docs/prd.md) | What and why, scope, requirements |
| [docs/architecture.md](./docs/architecture.md) | How it works, data model, failure modes |
| docs/redis-model.md | Redis keys and Lua invariants (next) |
| docs/failure-table.md | What breaks and what happens (next) |
| docs/openapi.yaml | API contract (generated from zod routes) |
| docs/adr/ | Architecture decision records |

## Benchmarks

To be filled in after the load tests: tenant B p99 under a tenant A flood, FIFO baseline vs Substrate.

## Roadmap

Cron, pub/sub, dashboard, billing, RBAC, managed Postgres, deploy hosting, multi-region.

## License

MIT