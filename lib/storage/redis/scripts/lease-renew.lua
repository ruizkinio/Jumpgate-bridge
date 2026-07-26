-- jg-script:lease-renew
local current = redis.call("TIME")
local now = (tonumber(current[1]) * 1000) + math.floor(tonumber(current[2]) / 1000)
if redis.call("EXISTS", KEYS[1]) == 0 then
  redis.call("ZREM", KEYS[3], KEYS[1])
  return { "not_owner" }
end
local expiresAt = tonumber(redis.call("HGET", KEYS[1], "expiresAt"))
if expiresAt <= now then
  local oldTokenIndex = redis.call("HGET", KEYS[1], "tokenIndexKey")
  if oldTokenIndex then redis.call("DEL", oldTokenIndex) end
  redis.call("DEL", KEYS[1])
  redis.call("ZREM", KEYS[3], KEYS[1])
  return { "not_owner" }
end
if redis.call("HGET", KEYS[1], "leaseTokenHash") ~= ARGV[1] then return { "not_owner" } end
if redis.call("GET", KEYS[2]) ~= KEYS[1] then return { "not_owner" } end

local renewedUntil = now + tonumber(ARGV[2])
redis.call("HSET", KEYS[1], "expiresAt", tostring(renewedUntil))
redis.call("PEXPIREAT", KEYS[1], renewedUntil)
redis.call("PEXPIREAT", KEYS[2], renewedUntil)
redis.call("ZADD", KEYS[3], renewedUntil, KEYS[1])
return { "renewed", tostring(renewedUntil) }
