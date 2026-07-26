-- jg-script:pairing-activate-v3
if #KEYS ~= 4 or #ARGV ~= 6 then return { "state_collision" } end
local current = redis.call("TIME")
local now = (tonumber(current[1]) * 1000) + math.floor(tonumber(current[2]) / 1000)
local userOwner = redis.call("GET", KEYS[1])
local retryOwner = redis.call("GET", KEYS[2])
if userOwner ~= ARGV[1] and retryOwner ~= ARGV[1] then return { "not_found" } end
if redis.call("EXISTS", KEYS[3]) == 0 then
  if userOwner == ARGV[1] then redis.call("DEL", KEYS[1]) end
  if retryOwner == ARGV[1] then redis.call("DEL", KEYS[2]) end
  return { "not_found" }
end
if redis.call("HGET", KEYS[3], "schemaVersion") ~= "2" or
   redis.call("HGET", KEYS[3], "pairingId") ~= ARGV[1] then return { "not_found" } end

local expiresAt = tonumber(redis.call("HGET", KEYS[3], "expiresAt"))
local deviceIndexKey = redis.call("HGET", KEYS[3], "deviceIndexKey")
if not expiresAt or expiresAt <= now then
  local retainUntil = now + tonumber(ARGV[4])
  redis.call("HSET", KEYS[3], "state", "expired")
  redis.call("HDEL", KEYS[3],
    "activationEnvelope", "activationDigest", "activationState", "finalizationHash")
  if userOwner == ARGV[1] then redis.call("DEL", KEYS[1]) end
  if retryOwner == ARGV[1] then redis.call("DEL", KEYS[2]) end
  redis.call("PEXPIREAT", KEYS[3], retainUntil)
  if deviceIndexKey then redis.call("PEXPIREAT", deviceIndexKey, retainUntil) end
  redis.call("ZREM", KEYS[4], KEYS[3])
  return { "expired" }
end

if retryOwner == ARGV[1] then
  if redis.call("HGET", KEYS[3], "activationRetryHash") ~= ARGV[5] then
    return { "not_found" }
  end
  local retryExpiresAt = tonumber(redis.call("HGET", KEYS[3], "activationRetryExpiresAt"))
  if not retryExpiresAt or retryExpiresAt <= now then
    redis.call("DEL", KEYS[2])
    return { "expired" }
  end
  local state = redis.call("HGET", KEYS[3], "state")
  if state == "cancelled" then return { "not_found" } end
  local activationState = redis.call("HGET", KEYS[3], "activationState")
  local existingDigest = redis.call("HGET", KEYS[3], "activationDigest")
  if existingDigest ~= ARGV[3] then return { "conflict" } end
  local existingEnvelope = redis.call("HGET", KEYS[3], "activationEnvelope")
  if not existingEnvelope then return { "conflict" } end
  return {
    activationState,
    redis.call("HGET", KEYS[3], "pairingId"),
    redis.call("HGET", KEYS[3], "deviceId"),
    existingDigest,
    tostring(expiresAt),
    existingEnvelope,
    tostring(retryExpiresAt)
  }
end
local state = redis.call("HGET", KEYS[3], "state")
if state ~= "pending" then return { "conflict" } end
if retryOwner then return { "not_found" } end
local retryExpiresAt = math.min(expiresAt, now + tonumber(ARGV[6]))
redis.call("HSET", KEYS[3],
  "state", "activating",
  "activationState", "activating",
  "activationEnvelope", ARGV[2],
  "activationDigest", ARGV[3],
  "activationRetryHash", ARGV[5],
  "activationRetryIndexKey", KEYS[2],
  "activationRetryExpiresAt", tostring(retryExpiresAt),
  "activationStartedAt", tostring(now))
redis.call("DEL", KEYS[1])
redis.call("SET", KEYS[2], ARGV[1])
redis.call("PEXPIREAT", KEYS[2], retryExpiresAt)
local physicalExpiry = math.max(expiresAt + tonumber(ARGV[4]), retryExpiresAt)
redis.call("PEXPIREAT", KEYS[3], physicalExpiry)
return {
  "activating",
  redis.call("HGET", KEYS[3], "pairingId"),
  redis.call("HGET", KEYS[3], "deviceId"),
  ARGV[3],
  tostring(expiresAt),
  ARGV[2],
  tostring(retryExpiresAt)
}
