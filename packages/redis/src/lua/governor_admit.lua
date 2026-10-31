-- governor_admit.lua
-- Atomic Tenant Governor Admission Control for Astra
--
-- Performs 3 checks in 1 atomic step:
--   1. Token Bucket Rate Limit (KEYS[1])
--   2. Daily Operations Quota (KEYS[2])
--   3. Queue Backlog Limit (KEYS[3], optional / empty string if not a queue operation)
--
-- KEYS:
--   KEYS[1] = Rate bucket key        (e.g., ratelimit:{pid}:bucket:<op>)
--   KEYS[2] = Daily quota key        (e.g., governor:{pid}:quota:YYYY-MM-DD)
--   KEYS[3] = Queue backlog key      (e.g., queue:{pid}:pending:<queueName>, or "" if none)
--
-- ARGV:
--   ARGV[1] = capacity               (number: max tokens allowed in bucket = rps)
--   ARGV[2] = refill_rate_per_sec    (number: tokens added per second = rps)
--   ARGV[3] = requested_cost         (number: tokens requested, usually 1)
--   ARGV[4] = max_ops_per_day        (number: max ops per UTC day)
--   ARGV[5] = max_backlog            (number: max backlog allowed in ready queue)
--   ARGV[6] = is_queue_op            (number: 1 if checking backlog, 0 otherwise)
--
-- RETURN VALUES:
--   Array: [status_code, retry_after_ms]
--   status_code:
--     0 = ADMITTED
--     1 = DENIED_RATE
--     2 = DENIED_QUOTA
--     3 = DENIED_BACKLOG

local rate_key       = KEYS[1]
local quota_key      = KEYS[2]
local backlog_key    = KEYS[3]

local capacity       = tonumber(ARGV[1])
local refill_rate    = tonumber(ARGV[2])
local cost           = tonumber(ARGV[3])
local max_ops        = tonumber(ARGV[4])
local max_backlog    = tonumber(ARGV[5])
local is_queue_op    = tonumber(ARGV[6])

-- 1. Obtain current Redis server time (sec, microsec)
local redis_time     = redis.call('TIME')
local now_sec        = tonumber(redis_time[1])
local now_usec       = tonumber(redis_time[2])
local now_ms         = (now_sec * 1000) + math.floor(now_usec / 1000)

-- =========================================================================
-- CHECK 1: Token Bucket Rate Limiting (Inspection phase)
-- =========================================================================
local bucket_data = redis.call('HMGET', rate_key, 'tokens', 'last_refill_ms')
local stored_tokens = tonumber(bucket_data[1])
local last_refill_ms = tonumber(bucket_data[2])

local current_tokens
if stored_tokens == nil or last_refill_ms == nil then
  -- First request: bucket starts at full capacity
  current_tokens = capacity
  last_refill_ms = now_ms
else
  -- Calculate elapsed time and refilled tokens
  local elapsed_ms = now_ms - last_refill_ms
  if elapsed_ms < 0 then
    elapsed_ms = 0
  end
  local refilled = (elapsed_ms / 1000.0) * refill_rate
  current_tokens = math.min(capacity, stored_tokens + refilled)
end

if current_tokens < cost then
  -- Denied by rate. Calculate time until enough tokens are available.
  local needed = cost - current_tokens
  local retry_after_ms = math.ceil((needed / refill_rate) * 1000.0)
  if retry_after_ms < 1 then
    retry_after_ms = 1
  end
  return { 1, retry_after_ms }
end

-- =========================================================================
-- CHECK 2: Daily Operations Quota (Inspection phase)
-- =========================================================================
local current_daily_ops = tonumber(redis.call('GET', quota_key)) or 0
if (current_daily_ops + cost) > max_ops then
  -- Denied by daily quota.
  -- Calculate milliseconds remaining until midnight UTC (estimated from current Redis time)
  local seconds_in_day = 86400
  local current_day_sec = now_sec % seconds_in_day
  local sec_until_midnight = seconds_in_day - current_day_sec
  local retry_after_ms = sec_until_midnight * 1000
  return { 2, retry_after_ms }
end

-- =========================================================================
-- CHECK 3: Queue Backlog (Inspection phase)
-- =========================================================================
if is_queue_op == 1 and backlog_key ~= "" then
  local queue_type = redis.call('TYPE', backlog_key)['ok']
  local current_depth = 0
  if queue_type == 'zset' then
    current_depth = redis.call('ZCARD', backlog_key)
  elseif queue_type == 'list' then
    current_depth = redis.call('LLEN', backlog_key)
  end

  if (current_depth + cost) > max_backlog then
    -- Denied by backlog. Suggest backoff (e.g. 500ms)
    return { 3, 500 }
  end
end

-- =========================================================================
-- COMMIT: All checks passed! Mutate state atomically.
-- =========================================================================

-- 1. Deduct tokens and persist bucket state
local remaining_tokens = current_tokens - cost
redis.call('HMSET', rate_key, 'tokens', remaining_tokens, 'last_refill_ms', now_ms)
-- Set TTL on rate key to expire when completely idle (e.g. 1 hour)
redis.call('EXPIRE', rate_key, 3600)

-- 2. Increment daily quota and ensure TTL is set (86400 * 2 seconds = 48 hours to cross midnight safely)
local new_daily_ops = redis.call('INCRBY', quota_key, cost)
if new_daily_ops == cost then
  -- Set expiration on first increment
  redis.call('EXPIRE', quota_key, 172800)
end

-- Admitted! Return [0, 0]
return { 0, 0 }

