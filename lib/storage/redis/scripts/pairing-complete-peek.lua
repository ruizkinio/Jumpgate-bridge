-- jg-script:pairing-complete-peek-v3
local current = redis.call("TIME")
local now = (tonumber(current[1]) * 1000) + math.floor(tonumber(current[2]) / 1000)
if redis.call("EXISTS", KEYS[1]) == 0 then return { "not_found" } end
if redis.call("HGET", KEYS[1], "schemaVersion") ~= "2" or
   redis.call("HGET", KEYS[1], "pairingId") ~= ARGV[1] then return { "not_found" } end

local state = redis.call("HGET", KEYS[1], "state")
if state == "cancelled" then return { "not_found" } end
local expiresAt = tonumber(redis.call("HGET", KEYS[1], "expiresAt"))
if not expiresAt or expiresAt <= now then
  return { "expired" }
end
local retryExpiresAt = tonumber(redis.call("HGET", KEYS[1], "activationRetryExpiresAt"))
if not retryExpiresAt or retryExpiresAt <= now then
  return { "expired" }
end

local digest = redis.call("HGET", KEYS[1], "activationDigest")
local envelope = redis.call("HGET", KEYS[1], "activationEnvelope")
if not digest or not envelope or digest ~= ARGV[2] then return { "conflict" } end
local activationState = redis.call("HGET", KEYS[1], "activationState")
if activationState ~= "activating" and activationState ~= "activated" then
  return { "invalid_state" }
end
return {
  "ready",
  activationState,
  tostring(expiresAt),
  envelope,
  digest,
  redis.call("HGET", KEYS[1], "finalizationHash") or "",
  tostring(retryExpiresAt)
}
