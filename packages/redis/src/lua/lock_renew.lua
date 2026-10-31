-- lock_renew.lua
-- Atomic Distributed Lock Lease Renewal
--
-- Only renews TTL if the caller's owner token matches the stored token.
--
-- KEYS[1] = lock key (lock:{projectId}:resource:<lockName>)
-- ARGV[1] = owner token
-- ARGV[2] = ttl extension in milliseconds
--
-- RETURNS:
--   1 if renewed successfully
--   0 if lease expired or owned by another client

local lock_key    = KEYS[1]
local owner_token = ARGV[1]
local ttl_ms      = tonumber(ARGV[2])

local current_owner = redis.call('GET', lock_key)

if current_owner == owner_token then
  redis.call('PEXPIRE', lock_key, ttl_ms)
  return 1
else
  return 0
end

