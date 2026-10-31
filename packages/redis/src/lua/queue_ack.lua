-- queue_ack.lua
-- Acknowledge (complete) a job
-- Only the claim owner can ACK. Verifies ownership via owner token stored in job hash.
--
-- KEYS[1] = processing sorted set (queue:{pid}:processing:<queue>)
-- KEYS[2] = job hash key          (queue:{pid}:job:<jobId>)
--
-- ARGV[1] = job_id
-- ARGV[2] = owner_token
--
-- RETURNS:
--   1 on success
--   0 if job not in processing or token mismatch

local processing_key = KEYS[1]
local job_key        = KEYS[2]

local job_id      = ARGV[1]
local owner_token = ARGV[2]

-- Verify job is in processing set
local score = redis.call('ZSCORE', processing_key, job_id)
if not score then
  return 0
end

-- Verify owner token matches
local stored_token = redis.call('HGET', job_key, 'ownerToken')
if stored_token ~= owner_token then
  return 0
end

-- Remove from processing and delete job hash
redis.call('ZREM', processing_key, job_id)
redis.call('DEL', job_key)

return 1

