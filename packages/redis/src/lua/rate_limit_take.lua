-- rate_limit_take.lua
-- Token bucket rate limiter using Redis server time.
-- Refills tokens continuously based on elapsed time since the last refill.
--
-- KEYS[1] = bucket key  (ratelimit:{pid}:bucket:<name>)
--
-- ARGV[1] = capacity          (maximum number of tokens in the bucket)
-- ARGV[2] = refill_rate_per_sec  (tokens added per second)
-- ARGV[3] = cost              (number of tokens to consume, usually 1)
--
-- RETURNS:
--   { 1, remaining, 0 }           -- allowed; remaining = tokens left after deduction
--   { 0, current_tokens, retry_after_ms } -- denied; retry_after_ms = estimated wait

local bucket_key = KEYS[1]

local capacity          = tonumber(ARGV[1])
local refill_rate       = tonumber(ARGV[2])  -- tokens per second
local cost              = tonumber(ARGV[3])

-- Use Redis server time for monotonic, clock-skew-resistant timing.
-- TIME returns { seconds, microseconds }.
local time_result  = redis.call('TIME')
local now_sec      = tonumber(time_result[1])
local now_us       = tonumber(time_result[2])
local now_ms       = now_sec * 1000 + math.floor(now_us / 1000)

-- Read current bucket state
local data = redis.call('HMGET', bucket_key, 'tokens', 'last_refill_ms')
local stored_tokens     = tonumber(data[1])
local last_refill_ms    = tonumber(data[2])

-- Initialise on first use
if stored_tokens == nil then
  stored_tokens  = capacity
  last_refill_ms = now_ms
end

-- Compute how many tokens to add based on elapsed time
local elapsed_ms     = math.max(0, now_ms - last_refill_ms)
local elapsed_sec    = elapsed_ms / 1000.0
local new_tokens     = elapsed_sec * refill_rate
local current_tokens = math.min(capacity, stored_tokens + new_tokens)

if current_tokens >= cost then
  -- Allow: deduct tokens and record refill time
  local remaining = current_tokens - cost
  redis.call('HMSET', bucket_key, 'tokens', remaining, 'last_refill_ms', now_ms)
  -- Keep bucket alive for 1 hour after last use
  redis.call('EXPIRE', bucket_key, 3600)
  return { 1, math.floor(remaining), 0 }
else
  -- Deny: save the partially-refilled count so refill is continuous
  redis.call('HMSET', bucket_key, 'tokens', current_tokens, 'last_refill_ms', now_ms)
  redis.call('EXPIRE', bucket_key, 3600)

  -- Estimate how long until enough tokens accumulate for one request
  local deficit       = cost - current_tokens
  local retry_after_ms = math.ceil((deficit / refill_rate) * 1000)
  return { 0, math.floor(current_tokens), retry_after_ms }
end

