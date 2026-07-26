-- jg-script:pairing-complete-v3
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
local requestedFinalizationHash = ARGV[6]
local existingFinalizationHash = redis.call("HGET", KEYS[1], "finalizationHash")
if existingFinalizationHash then
  if requestedFinalizationHash ~= "" and
     existingFinalizationHash ~= requestedFinalizationHash then
    return { "conflict" }
  end
  return { "activated", tostring(expiresAt), envelope, digest, tostring(retryExpiresAt) }
end
if ARGV[4] == "" or ARGV[5] == "" or envelope ~= ARGV[4] then return { "conflict" } end
if requestedFinalizationHash ~= "" then
  redis.call("HSET", KEYS[1],
    "activationState", "activated",
    "activatedAt", tostring(now),
    "activationEnvelope", ARGV[5],
    "finalizationHash", requestedFinalizationHash)
  if state == "activating" then redis.call("HSET", KEYS[1], "state", "activated") end
  return { "activated", tostring(expiresAt), ARGV[5], digest, tostring(retryExpiresAt) }
end

if ARGV[5] ~= envelope then return { "conflict" } end
if activationState == "activating" then
  redis.call("HSET", KEYS[1], "activationState", "activated", "activatedAt", tostring(now))
  if state == "activating" then redis.call("HSET", KEYS[1], "state", "activated") end
end
return { "activated", tostring(expiresAt), envelope, digest, tostring(retryExpiresAt) }
