-- queue_enqueue.lua
-- Atomically enqueue a job or return existing job for idempotency key
--
-- KEYS[1] = pending sorted set key  (queue:{pid}:pending:<queue>)
-- KEYS[2] = job hash key            (queue:{pid}:job:<jobId>)
-- KEYS[3] = idempotency key         (queue:{pid}:idem:<idemKey>  or "" if none)
--
-- ARGV[1] = jobId
-- ARGV[2] = payload (JSON string)
-- ARGV[3] = run_at_ms  (score for sorted set, = now + delayMs)
-- ARGV[4] = max_attempts
-- ARGV[5] = created_at_ms
-- ARGV[6] = has_idem_key  (1 or 0)
--
-- RETURNS:
--   { 1, jobId }  -> new job created
--   { 0, existing_jobId }  -> idempotency match, existing job returned

local pending_key = KEYS[1]
local job_key     = KEYS[2]
local idem_key    = KEYS[3]

local job_id       = ARGV[1]
local payload      = ARGV[2]
local run_at_ms    = tonumber(ARGV[3])
local max_attempts = ARGV[4]
local created_at   = ARGV[5]
local has_idem     = tonumber(ARGV[6])

-- Check idempotency key
if has_idem == 1 and idem_key ~= "" then
  local existing_id = redis.call('GET', idem_key)
  if existing_id then
    return { 0, existing_id }
  end
end

-- Store job data in a hash
redis.call('HSET', job_key,
  'payload',      payload,
  'attempts',     '0',
  'maxAttempts',  max_attempts,
  'createdAt',    created_at,
  'status',       'pending'
)

-- Add to pending sorted set with score = runAt ms
redis.call('ZADD', pending_key, run_at_ms, job_id)

-- Register idempotency key with 24h TTL
if has_idem == 1 and idem_key ~= "" then
  redis.call('SET', idem_key, job_id, 'EX', 86400)
end

return { 1, job_id }

