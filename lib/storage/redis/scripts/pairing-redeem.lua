-- jg-script:pairing-redeem-v2
local current = redis.call("TIME")
local now = (tonumber(current[1]) * 1000) + math.floor(tonumber(current[2]) / 1000)
if redis.call("GET", KEYS[1]) ~= ARGV[1] then return { "not_found" } end
if redis.call("EXISTS", KEYS[2]) == 0 then
  redis.call("DEL", KEYS[1])
  return { "not_found" }
end
if redis.call("HGET", KEYS[2], "schemaVersion") ~= "2" or
   redis.call("HGET", KEYS[2], "pairingId") ~= ARGV[1] then return { "not_found" } end

local state = redis.call("HGET", KEYS[2], "state")
local expiresAt = tonumber(redis.call("HGET", KEYS[2], "expiresAt"))
local userIndexKey = redis.call("HGET", KEYS[2], "userIndexKey")
if expiresAt <= now and state ~= "consumed" and state ~= "cancelled" and state ~= "expired" then
  local retainUntil = now + tonumber(ARGV[2])
  local retryExpiresAt = tonumber(redis.call("HGET", KEYS[2], "activationRetryExpiresAt"))
  redis.call("HSET", KEYS[2], "state", "expired")
  if not retryExpiresAt or retryExpiresAt <= now then
    redis.call("HDEL", KEYS[2],
      "activationEnvelope", "activationDigest", "activationState", "finalizationHash")
  else
    retainUntil = math.max(retainUntil, retryExpiresAt)
  end
  if userIndexKey and redis.call("GET", userIndexKey) == ARGV[1] then
    redis.call("DEL", userIndexKey)
  end
  redis.call("PEXPIREAT", KEYS[2], retainUntil)
  if redis.call("GET", KEYS[1]) == ARGV[1] then redis.call("PEXPIREAT", KEYS[1], retainUntil) end
  redis.call("ZREM", KEYS[3], KEYS[2])
  return { "expired" }
end
if state == "cancelled" or state == "expired" then return { state } end
if state == "consumed" then
  local replayEnvelope = redis.call("HGET", KEYS[2], "activationEnvelope")
  local replayDigest = redis.call("HGET", KEYS[2], "activationDigest")
  if replayEnvelope == ARGV[3] and replayDigest == ARGV[4] then
    return {
      "redeemed",
      redis.call("HGET", KEYS[2], "pairingId"),
      redis.call("HGET", KEYS[2], "deviceId")
    }
  end
  return { "consumed" }
end
local finalizationHash = redis.call("HGET", KEYS[2], "finalizationHash")
local activationState = redis.call("HGET", KEYS[2], "activationState")
if state ~= "activated" or activationState ~= "activated" or not finalizationHash then
  return { "pending", state, redis.call("HGET", KEYS[2], "pairingId"), tostring(expiresAt) }
end

local envelope = redis.call("HGET", KEYS[2], "activationEnvelope")
local digest = redis.call("HGET", KEYS[2], "activationDigest")
if not envelope or not digest or envelope ~= ARGV[3] or digest ~= ARGV[4] then
  return { "pending", state, redis.call("HGET", KEYS[2], "pairingId"), tostring(expiresAt) }
end
local pairingId = redis.call("HGET", KEYS[2], "pairingId")
local deviceId = redis.call("HGET", KEYS[2], "deviceId")
local retainUntil = now + tonumber(ARGV[2])
local retryExpiresAt = tonumber(redis.call("HGET", KEYS[2], "activationRetryExpiresAt"))
if retryExpiresAt and retryExpiresAt > retainUntil then retainUntil = retryExpiresAt end
redis.call("HSET", KEYS[2], "state", "consumed")
if userIndexKey and redis.call("GET", userIndexKey) == pairingId then
  redis.call("DEL", userIndexKey)
end
redis.call("PEXPIREAT", KEYS[2], retainUntil)
if redis.call("GET", KEYS[1]) == pairingId then redis.call("PEXPIREAT", KEYS[1], retainUntil) end
redis.call("ZREM", KEYS[3], KEYS[2])
return { "redeemed", pairingId, deviceId }
