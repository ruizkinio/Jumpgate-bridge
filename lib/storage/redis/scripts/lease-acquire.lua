-- jg-script:lease-acquire
local current = redis.call("TIME")
local now = (tonumber(current[1]) * 1000) + math.floor(tonumber(current[2]) / 1000)
redis.call("ZREMRANGEBYSCORE", KEYS[3], "-inf", now)

if redis.call("EXISTS", KEYS[1]) == 1 then
  local existingExpiry = tonumber(redis.call("HGET", KEYS[1], "expiresAt"))
  if existingExpiry > now then return { "busy", tostring(existingExpiry) } end
  local oldTokenIndex = redis.call("HGET", KEYS[1], "tokenIndexKey")
  if oldTokenIndex then redis.call("DEL", oldTokenIndex) end
  redis.call("DEL", KEYS[1])
end
if redis.call("ZCARD", KEYS[3]) >= tonumber(ARGV[4]) then return { "capacity" } end
if redis.call("EXISTS", KEYS[2]) == 1 then return { "token_collision" } end

local expiresAt = now + tonumber(ARGV[3])
redis.call("HSET", KEYS[1],
  "schemaVersion", "1",
  "owner", ARGV[1],
  "leaseTokenHash", ARGV[2],
  "tokenIndexKey", KEYS[2],
  "createdAt", tostring(now),
  "expiresAt", tostring(expiresAt))
redis.call("SET", KEYS[2], KEYS[1])
redis.call("PEXPIREAT", KEYS[2], expiresAt)
redis.call("PEXPIREAT", KEYS[1], expiresAt)
redis.call("ZADD", KEYS[3], expiresAt, KEYS[1])
return { "acquired", tostring(expiresAt) }
