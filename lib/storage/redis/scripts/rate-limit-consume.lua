-- jg-script:rate-limit-consume
local current = redis.call("TIME")
local now = (tonumber(current[1]) * 1000) + math.floor(tonumber(current[2]) / 1000)
redis.call("ZREMRANGEBYSCORE", KEYS[2], "-inf", now)

if redis.call("EXISTS", KEYS[1]) == 1 then
  local currentReset = tonumber(redis.call("HGET", KEYS[1], "resetAt"))
  if currentReset <= now then redis.call("DEL", KEYS[1]) end
end

local resetAt
local count
if redis.call("EXISTS", KEYS[1]) == 0 then
  if redis.call("ZCARD", KEYS[2]) >= tonumber(ARGV[4]) then return { "capacity" } end
  resetAt = now + tonumber(ARGV[2])
  count = 0
  redis.call("HSET", KEYS[1],
    "schemaVersion", "1",
    "count", "0",
    "limit", ARGV[1],
    "windowMs", ARGV[2],
    "resetAt", tostring(resetAt))
  redis.call("PEXPIREAT", KEYS[1], resetAt)
  redis.call("ZADD", KEYS[2], resetAt, KEYS[1])
else
  if redis.call("HGET", KEYS[1], "limit") ~= ARGV[1] or
     redis.call("HGET", KEYS[1], "windowMs") ~= ARGV[2] then
    return { "policy_mismatch" }
  end
  resetAt = tonumber(redis.call("HGET", KEYS[1], "resetAt"))
  count = tonumber(redis.call("HGET", KEYS[1], "count"))
end

count = math.min(9007199254740991, count + tonumber(ARGV[3]))
redis.call("HSET", KEYS[1], "count", string.format("%.0f", count))
local limit = tonumber(ARGV[1])
local allowed = "0"
if count <= limit then allowed = "1" end
local remaining = math.max(0, limit - count)
return { "consumed", allowed, string.format("%.0f", remaining), tostring(resetAt) }
