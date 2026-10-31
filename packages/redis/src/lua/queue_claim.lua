-- queue_claim.lua
-- Atomically claim the next eligible job from the pending queue
--
-- KEYS[1] = pending sorted set  (queue:{pid}:pending:<queue>)
-- KEYS[2] = processing sorted set (queue:{pid}:processing:<queue>)
--
-- ARGV[1] = now_ms          (current Redis server time in ms)
-- ARGV[2] = lease_expiry_ms (absolute timestamp when lease expires, = now_ms + leaseTtlMs)
-- ARGV[3] = owner_token     (unique token for this claim)
--
-- RETURNS:
--   { jobId, job_hash_key_suffix } on success
--   nil when no eligible job is available

local pending_key    = KEYS[1]
local processing_key = KEYS[2]

local now_ms         = tonumber(ARGV[1])
local lease_expiry   = tonumber(ARGV[2])
local owner_token    = ARGV[3]

-- Find the first job with score <= now_ms (runAt in the past or now)
local results = redis.call('ZRANGEBYSCORE', pending_key, '-inf', now_ms, 'LIMIT', 0, 1)

if #results == 0 then
  return nil
end

local job_id = results[1]

-- Move from pending to processing
redis.call('ZREM', pending_key, job_id)
redis.call('ZADD', processing_key, lease_expiry, job_id)

return { job_id, owner_token }

