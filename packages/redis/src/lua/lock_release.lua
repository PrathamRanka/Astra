-- lock_release.lua
-- Safe Distributed Lock Release
--
-- Only deletes the lock if the caller's owner token matches the stored token.
-- Prevents a client from accidentally releasing a lock acquired by another client after TTL expiry.
--
-- KEYS[1] = lock key (lock:{projectId}:resource:<lockName>)
-- ARGV[1] = owner token
--
-- RETURNS:
--   1 if released
--   0 if token mismatched or lock did not exist

local lock_key    = KEYS[1]
local owner_token = ARGV[1]

local current_owner = redis.call('GET', lock_key)

if current_owner == owner_token then
  redis.call('DEL', lock_key)
  return 1
else
  return 0
end

