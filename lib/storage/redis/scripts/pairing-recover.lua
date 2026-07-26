-- jg-script:pairing-recover-v3
if #KEYS ~= 2 or #ARGV ~= 3 then return { "state_collision" } end
local current = redis.call("TIME")
local now = (tonumber(current[1]) * 1000) + math.floor(tonumber(current[2]) / 1000)
if redis.call("GET", KEYS[1]) ~= ARGV[1] then return { "not_found" } end
if redis.call("EXISTS", KEYS[2]) == 0 then
  redis.call("DEL", KEYS[1])
  return { "not_found" }
end
if redis.call("HGET", KEYS[2], "schemaVersion") ~= "2" or
   redis.call("HGET", KEYS[2], "pairingId") ~= ARGV[1] or
   redis.call("HGET", KEYS[2], "activationRetryHash") ~= ARGV[2] then
  return { "not_found" }
end
local expiresAt = tonumber(redis.call("HGET", KEYS[2], "expiresAt"))
if not expiresAt or expiresAt <= now then
  redis.call("DEL", KEYS[1])
  return { "expired" }
end
local retryExpiresAt = tonumber(redis.call("HGET", KEYS[2], "activationRetryExpiresAt"))
if not retryExpiresAt or retryExpiresAt <= now then
  redis.call("DEL", KEYS[1])
  return { "expired" }
end
local state = redis.call("HGET", KEYS[2], "state")
if state == "cancelled" then return { "not_found" } end
local activationState = redis.call("HGET", KEYS[2], "activationState")
if activationState ~= "activating" and activationState ~= "activated" then
  return { "not_found" }
end
local digest = redis.call("HGET", KEYS[2], "activationDigest")
if not digest or digest ~= ARGV[3] then return { "conflict" } end
local envelope = redis.call("HGET", KEYS[2], "activationEnvelope")
if not envelope then return { "not_found" } end
return {
  activationState,
  ARGV[1],
  redis.call("HGET", KEYS[2], "deviceId"),
  digest,
  redis.call("HGET", KEYS[2], "expiresAt"),
  envelope,
  tostring(retryExpiresAt)
}
