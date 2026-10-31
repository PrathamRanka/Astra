-- queue_nack.lua
-- Negative-acknowledge: retry or dead-letter a job
--
-- KEYS[1] = processing sorted set  (queue:{pid}:processing:<queue>)
-- KEYS[2] = pending sorted set     (queue:{pid}:pending:<queue>)
-- KEYS[3] = dead-letter list       (queue:{pid}:dead-letter:<queue>)
-- KEYS[4] = job hash key           (queue:{pid}:job:<jobId>)
--
-- ARGV[1] = job_id
-- ARGV[2] = owner_token
-- ARGV[3] = retry_at_ms   (absolute timestamp when job becomes eligible again)
-- ARGV[4] = new_attempts  (incremented attempt count)
-- ARGV[5] = max_attempts
-- ARGV[6] = now_ms        (for updating job metadata)
--
-- RETURNS:
--   1 = requeued for retry
--   2 = moved to dead-letter queue (attempts exhausted)
--   0 = job not found or token mismatch

local processing_key = KEYS[1]
local pending_key    = KEYS[2]
local dlq_key        = KEYS[3]
local job_key        = KEYS[4]

local job_id       = ARGV[1]
local owner_token  = ARGV[2]
local retry_at_ms  = tonumber(ARGV[3])
local new_attempts = tonumber(ARGV[4])
local max_attempts = tonumber(ARGV[5])

-- Verify job is in processing set
local score = redis.call('ZSCORE', processing_key, job_id)
if not score then
  return 0
end

-- Verify owner token
local stored_token = redis.call('HGET', job_key, 'ownerToken')
if stored_token ~= owner_token then
  return 0
end

-- Remove from processing
redis.call('ZREM', processing_key, job_id)

if new_attempts >= max_attempts then
  -- Attempts exhausted: move to dead-letter list
  local job_data = redis.call('HGETALL', job_key)
  redis.call('LPUSH', dlq_key, job_id)
  redis.call('HSET', job_key, 'status', 'dead', 'attempts', new_attempts)
  return 2
else
  -- Requeue with updated attempt count and retry delay
  redis.call('HSET', job_key, 'attempts', new_attempts, 'status', 'pending', 'ownerToken', '')
  redis.call('ZADD', pending_key, retry_at_ms, job_id)
  return 1
end

