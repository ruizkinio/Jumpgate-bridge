-- jg-script:pairing-cancel-v2
local current = redis.call("TIME")
local now = (tonumber(current[1]) * 1000) + math.floor(tonumber(current[2]) / 1000)
if redis.call("GET", KEYS[1]) ~= ARGV[1] then return { "not_found" } end
if redis.call("EXISTS", KEYS[2]) == 0 then
  redis.call("DEL", KEYS[1])
  return { "not_found" }
end
if redis.call("HGET", KEYS[2], "schemaVersion") ~= "2" then return { "not_found" } end
local state = redis.call("HGET", KEYS[2], "state")
if state == "consumed" or state == "cancelled" or state == "expired" then return { "not_found" } end
local expiresAt = tonumber(redis.call("HGET", KEYS[2], "expiresAt"))
if expiresAt <= now then
  state = "expired"
else
  state = "cancelled"
end
local retainUntil = now + tonumber(ARGV[2])
local userIndexKey = redis.call("HGET", KEYS[2], "userIndexKey")
local retryIndexKey = redis.call("HGET", KEYS[2], "activationRetryIndexKey")
redis.call("HSET", KEYS[2], "state", state)
redis.call("HDEL", KEYS[2],
  "activationEnvelope", "activationDigest", "activationState", "activationRetryHash",
  "activationRetryExpiresAt", "activationRetryIndexKey", "finalizationHash")
if userIndexKey then redis.call("DEL", userIndexKey) end
if retryIndexKey then redis.call("DEL", retryIndexKey) end
redis.call("PEXPIREAT", KEYS[2], retainUntil)
redis.call("PEXPIREAT", KEYS[1], retainUntil)
redis.call("ZREM", KEYS[3], KEYS[2])
return { state }
