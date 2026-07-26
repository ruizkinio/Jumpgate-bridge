-- jg-script:management-authenticate
local current = redis.call("TIME")
local now = (tonumber(current[1]) * 1000) + math.floor(tonumber(current[2]) / 1000)
local function deny_pairing_replay()
  local replayKey = redis.call("HGET", KEYS[1], "pairingReplayKey")
  local denialExpiresAt = tonumber(redis.call("HGET", KEYS[1], "pairingReplayDenialExpiresAt"))
  if not replayKey or redis.call("EXISTS", replayKey) == 0 then return end
  if redis.call("HGET", replayKey, "sessionKey") ~= KEYS[1] then return end
  redis.call("HSET", replayKey, "status", "denied", "deniedAt", tostring(now))
  redis.call("HDEL", replayKey, "authorityEnvelope", "sessionKey", "sessionExpiresAt")
  if denialExpiresAt and denialExpiresAt > now then
    redis.call("PEXPIREAT", replayKey, denialExpiresAt)
  else
    redis.call("DEL", replayKey)
  end
end
local function remove_session()
  local profileIndexKey = redis.call("HGET", KEYS[1], "profileIndexKey")
  deny_pairing_replay()
  redis.call("DEL", KEYS[1])
  redis.call("ZREM", KEYS[2], KEYS[1])
  if profileIndexKey then redis.call("ZREM", profileIndexKey, KEYS[1]) end
end
if redis.call("EXISTS", KEYS[1]) == 0 then
  redis.call("ZREM", KEYS[2], KEYS[1])
  return { "not_found" }
end
local expiresAt = tonumber(redis.call("HGET", KEYS[1], "expiresAt"))
if expiresAt <= now then
  remove_session()
  return { "not_found" }
end
if redis.call("HGET", KEYS[1], "csrfHash") ~= ARGV[1] then return { "csrf_mismatch" } end
local managementGeneration = redis.call("HGET", KEYS[1], "managementGeneration")
local profileGenerationKey = redis.call("HGET", KEYS[1], "profileGenerationKey")
if not managementGeneration or not string.match(managementGeneration, "^[0-9]+$") or
   #managementGeneration > 16 or not profileGenerationKey then
  return { "state_collision" }
end
local generationType = redis.call("TYPE", profileGenerationKey)
if type(generationType) == "table" then generationType = generationType.ok end
if generationType ~= "none" and generationType ~= "string" then
  return { "state_collision" }
end
local currentGeneration = generationType == "none" and "0" or redis.call("GET", profileGenerationKey)
if currentGeneration ~= managementGeneration then
  remove_session()
  return { "not_found" }
end
return {
  "authenticated",
  redis.call("HGET", KEYS[1], "profileId"),
  tostring(expiresAt),
  managementGeneration
}
