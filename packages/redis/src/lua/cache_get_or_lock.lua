-- cache_get_or_lock.lua
-- Atomically check cache and acquire a refresh lock if the value is missing.
-- This prevents cache stampede: only the first caller loads the value.
--
-- KEYS[1] = value key  (cache:{pid}:entry:<key>)
-- KEYS[2] = lock key   (cache:{pid}:lock:<key>)
--
-- ARGV[1] = lock_token   (unique token identifying this caller)
-- ARGV[2] = lock_ttl_ms  (how long the refresh lock is held, in ms)
--
-- RETURNS:
--   { 1, value }     -- cache hit, value is a Redis bulk string
--   { 0, "LOCKED" }  -- cache miss, caller won the lock and must run the loader
--   { 0, "WAIT" }    -- cache miss, another caller holds the lock; caller should poll

local value_key   = KEYS[1]
local lock_key    = KEYS[2]

local lock_token   = ARGV[1]
local lock_ttl_ms  = tonumber(ARGV[2])

-- Try to read the cached value first
local value = redis.call('GET', value_key)
if value then
  return { 1, value }
end

-- Value is not cached. Try to acquire the refresh lock.
-- SET NX PX is atomic: only one caller wins.
local acquired = redis.call('SET', lock_key, lock_token, 'NX', 'PX', lock_ttl_ms)

if acquired then
  -- This caller owns the lock and must run the loader, then SET the value and DEL the lock.
  return { 0, 'LOCKED' }
else
  -- Another caller already holds the lock. This caller should poll briefly then retry.
  return { 0, 'WAIT' }
end

