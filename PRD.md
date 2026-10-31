# Substrate PRD

| | |
|---|---|
| Author | Pratham |
| Status | Draft v0.1 |
| Date | 2026-10-31 |
| Timebox | 2-3 day build, local-only (Docker + kind) |

## 1. Problem

Backend teams assemble distributed primitives from unrelated tools: a Redis cache, a job queue library, a lock helper, a rate limiter, a cron runner. Each has its own client, auth, limits and metrics. None of them share a notion of a tenant, so when one customer floods the system, caches evict, queues back up and locks contend for everyone. Teams discover this in production.

## 2. Vision

One open-source platform that exposes cache, queue, lock and rate limiting behind a single API key and SDK, with a shared Tenant Governor that enforces fairness, quotas and backpressure across all of them and meters every operation.

## 3. Users

| Persona | Need |
|---|---|
| Backend developer at a small team | Add queues, locks and caching without running five systems |
| Platform engineer building a multi-tenant SaaS | Isolate tenants so one cannot degrade the rest |
| Learner / contributor | Readable reference implementation of distributed-systems patterns |

## 4. Goals

- G1. One API key and SDK for all four primitives.
- G2. A noisy tenant cannot starve others. Demonstrable with a benchmark.
- G3. Correctness under failure: no double-lock, no lost jobs on worker crash, no cache stampede.
- G4. Every operation is metered per project.
- G5. Runs locally with `make up` or on kind with `make k8s-apply`.
- G6. Docs and diagrams good enough to double as build-in-public content.

## 5. Non-goals (v1)

- Hosted cloud, billing, payments.
- Strong tenant isolation (separate Redis instances per tenant). v1 uses logical isolation by key namespace.
- Multi-region, Redis Cluster operation. Key names are cluster-ready, but v1 targets a single Redis.
- Exactly-once job execution. v1 is at-least-once with idempotency keys.
- Dashboard UI (stretch), RBAC, SSO.
- Replacing Redis or Postgres. Substrate orchestrates them.

## 6. Functional requirements

**Platform**
- FR-1. Admin can create orgs, projects and plans. Plan fields: weight, rps, maxConcurrency, maxBacklog, memBytes, opsPerDay.
- FR-2. Admin can create and revoke project API keys. Keys are shown once and stored as sha256 hashes.
- FR-3. Every request is authenticated, attributed to a project, and checked by the Governor before reaching a primitive.
- FR-4. Denials return `429` with `Retry-After` and a machine-readable reason (`RATE`, `QUOTA`, `BACKLOG`).

**Cache**
- FR-5. `get/set/delete` with TTL and per-project memory quota.
- FR-6. `getOrLoad` coalesces concurrent misses into a single loader call.
- FR-7. Early probabilistic refresh of soft-expired entries.

**Queue**
- FR-8. Enqueue jobs with payload, delay, priority, `maxAttempts`, optional target URL, and `Idempotency-Key`.
- FR-9. Per-tenant scheduling with Deficit Round Robin weighted by plan.
- FR-10. Claim jobs with a lease. Ack, nack and heartbeat endpoints.
- FR-11. Expired leases are re-queued automatically. Exceeding `maxAttempts` moves a job to the DLQ.
- FR-12. DLQ listing and manual retry.
- FR-13. Push delivery: worker POSTs the job to its target URL with an HMAC signature.

**Lock**
- FR-14. Acquire, renew, release with TTL.
- FR-15. Every grant returns a monotonically increasing fencing token per lock name.

**Rate limiter**
- FR-16. `take(name, cost)` token bucket usable standalone, returning `allowed`, `remaining`, `retryAfterMs`.

**Metering and ops**
- FR-17. Each operation emits a usage event. Hourly rollups per project and operation are queryable at `GET /v1/usage`.
- FR-18. `/metrics` (Prometheus), `/healthz`, `/readyz` on every service.
- FR-19. TypeScript SDK covering all primitives, and a CLI for keys, queues and usage.

## 7. Non-functional requirements

Targets to validate, not claims.

| ID | Requirement | Target |
|---|---|---|
| NFR-1 | Governor overhead per request | p99 under 5 ms on local Redis |
| NFR-2 | Fairness | Under a 100x flood by tenant A, tenant B p99 enqueue-to-dispatch stays within 2x of its idle baseline |
| NFR-3 | Durability | Worker kill mid-job loses zero jobs; job re-delivered after lease expiry |
| NFR-4 | Lock safety | A stale holder's write is rejected by fencing token in the demo |
| NFR-5 | Stampede | 1000 concurrent misses cause 1 loader call |
| NFR-6 | Availability | Killing any one gateway, worker or scheduler pod does not interrupt service |
| NFR-7 | Security | API keys hashed, scoped, revocable. No secrets in logs |
| NFR-8 | Observability | Every request has a trace ID; metrics for denials, queue depth, lease expiries |

## 8. Success metrics

- Benchmark graph (FIFO vs Substrate) reproducible with one command.
- Chaos test passes: random pod kills during a load test produce zero lost jobs and no double-held locks.
- All FRs marked in scope are covered by integration tests.
- README quickstart works from a clean clone.
- Three LinkedIn posts published with diagrams and results.

## 9. Scope and phasing

| Phase | Content |
|---|---|
| Must (day 1-2) | Control plane, API keys, Governor, rate limiter, cache, fair queue, locks, metering |
| Must (day 3) | SDK, k8s on kind, benchmark, docs |
| Stretch | Cron, pub/sub, dashboard |
| Roadmap | Billing, RBAC, managed Postgres, deploy hosting, multi-region |

## 10. Risks

| Risk | Mitigation |
|---|---|
| Scope too large for 3 days | Cut stretch items first. Queue and Governor are the priority |
| Lua scripts hard to test | Integration tests against real Redis in docker |
| DRR scheduler is a single point | Leader election in Redis, deficits stored in Redis so a new leader continues |
| Benchmarks misleading on a laptop | Report setup, percentiles and variance, not just averages |
| Metering overcounts on retry | Documented as at-least-once in v1, dedupe by request ID in v2 |

## 11. Open questions

- Worker push delivery vs pull-only for v1? Current decision: both, push is optional per job.
- Should cache values live in the same Redis as queues? v1 yes, with per-project memory accounting.
- OpenAPI generated from zod routes or hand-written? Current decision: generated.