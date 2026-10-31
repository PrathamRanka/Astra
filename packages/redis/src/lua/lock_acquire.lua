-- lock_acquire.lua
-- Atomic Distributed Lock Acquisition with Monotonic Fencing Token
--
-- KEYS[1] = lock key (lock:{projectId}:resource:<lockName>)
-- KEYS[2] = fence key (lock:{projectId}:fence:<lockName>)
--
-- ARGV[1] = owner token (unique string per acquisition attempt)
-- ARGV[2] = ttl in milliseconds
--
-- RETURNS:
--   On success: { 1, fencing_token }
--   On failure (already held): { 0, 0 }

local lock_key  = KEYS[1]
local fence_key = KEYS[2]

local owner_token = ARGV[1]
local ttl_ms      = tonumber(ARGV[2])

-- Try to acquire lock key with SET NX PX
local acquired = redis.call('SET', lock_key, owner_token, 'NX', 'PX', ttl_ms)

if acquired then
  -- Lock acquired! Increment monotonic fencing token counter
  local fence_token = redis.call('INCR', fence_key)
  return { 1, fence_token }
else
  return { 0, 0 }
end

