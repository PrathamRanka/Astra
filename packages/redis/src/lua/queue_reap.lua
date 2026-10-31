-- queue_reap.lua
-- Recover jobs with expired leases from the processing set.
-- Jobs within max attempts are requeued; exhausted jobs move to dead-letter.
--
-- All keys share the same {projectId} cluster hash tag so they always land on
-- the same Redis slot. That is why iterating dynamic job keys inside Lua is safe here.
--
-- KEYS[1] = processing sorted set  (queue:{pid}:processing:<queue>)
-- KEYS[2] = pending sorted set     (queue:{pid}:pending:<queue>)
-- KEYS[3] = dead-letter list       (queue:{pid}:dead-letter:<queue>)
-- KEYS[4] = job key prefix base    (queue:{pid}:job)  -- we append :<jobId> per job
--
-- ARGV[1] = now_ms     (current time in ms; jobs with lease_expiry <= now are stale)
-- ARGV[2] = batch_size (max number of stale jobs to process in one call)
--
-- RETURNS:
--   { requeued_count, dead_lettered_count }

local processing_key  = KEYS[1]
local pending_key     = KEYS[2]
local dlq_key         = KEYS[3]
local job_key_prefix  = KEYS[4]

local now_ms     = tonumber(ARGV[1])
local batch_size = tonumber(ARGV[2])

-- Find jobs whose lease has expired (score <= now_ms)
local stale_jobs = redis.call('ZRANGEBYSCORE', processing_key, '-inf', now_ms, 'LIMIT', 0, batch_size)

local requeued      = 0
local dead_lettered = 0

for _, job_id in ipairs(stale_jobs) do
  local job_key = job_key_prefix .. ':' .. job_id

  local attempts_str     = redis.call('HGET', job_key, 'attempts')
  local max_attempts_str = redis.call('HGET', job_key, 'maxAttempts')

  local attempts     = tonumber(attempts_str) or 0
  local max_attempts = tonumber(max_attempts_str) or 1

  -- Remove the stale lease from processing
  redis.call('ZREM', processing_key, job_id)

  if attempts >= max_attempts then
    -- Attempts exhausted: move to dead-letter list
    redis.call('HSET', job_key, 'status', 'dead')
    redis.call('LPUSH', dlq_key, job_id)
    dead_lettered = dead_lettered + 1
  else
    -- Requeue immediately (score = now_ms so it is eligible right away)
    redis.call('HSET', job_key, 'status', 'pending', 'ownerToken', '')
    redis.call('ZADD', pending_key, now_ms, job_id)
    requeued = requeued + 1
  end
end

return { requeued, dead_lettered }

