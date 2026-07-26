-- jg-script:management-pairing-recover
if #KEYS ~= 2 or #ARGV ~= 2 then return { "state_collision" } end
local replayType = redis.call("TYPE", KEYS[1])
if type(replayType) == "table" then replayType = replayType.ok end
if replayType == "none" then return { "not_found" } end
if replayType ~= "hash" or redis.call("HGET", KEYS[1], "schemaVersion") ~= "1" then
  return { "state_collision" }
end
if redis.call("HGET", KEYS[1], "pairingHash") ~= ARGV[1] then return { "not_found" } end
if redis.call("HGET", KEYS[1], "configHash") ~= ARGV[2] then return { "conflict" } end
local current = redis.call("TIME")
local now = (tonumber(current[1]) * 1000) + math.floor(tonumber(current[2]) / 1000)
redis.call("ZREMRANGEBYSCORE", KEYS[2], "-inf", now)
local denialExpiresAt = tonumber(redis.call("HGET", KEYS[1], "denialExpiresAt"))
if not denialExpiresAt then return { "state_collision" } end
if denialExpiresAt <= now then
  redis.call("DEL", KEYS[1])
  return { "not_found" }
end

local function remove_session(sessionKey)
  if not sessionKey then return end
  local profileIndexKey = nil
  if redis.call("EXISTS", sessionKey) == 1 then
    profileIndexKey = redis.call("HGET", sessionKey, "profileIndexKey")
    redis.call("DEL", sessionKey)
  end
  redis.call("ZREM", KEYS[2], sessionKey)
  if profileIndexKey then redis.call("ZREM", profileIndexKey, sessionKey) end
end
local function deny(revokeSession)
  local sessionKey = redis.call("HGET", KEYS[1], "sessionKey")
  if revokeSession then remove_session(sessionKey) end
  redis.call("HSET", KEYS[1], "status", "denied", "deniedAt", tostring(now))
  redis.call("HDEL", KEYS[1], "authorityEnvelope", "sessionKey", "sessionExpiresAt")
  redis.call("PEXPIREAT", KEYS[1], denialExpiresAt)
end

if redis.call("HGET", KEYS[1], "status") ~= "issued" then return { "denied" } end
local replayExpiresAt = tonumber(redis.call("HGET", KEYS[1], "replayExpiresAt"))
if not replayExpiresAt or replayExpiresAt <= now then
  deny(false)
  return { "denied" }
end
local sessionKey = redis.call("HGET", KEYS[1], "sessionKey")
if not sessionKey or redis.call("EXISTS", sessionKey) == 0 then
  deny(true)
  return { "denied" }
end
local expiresAt = tonumber(redis.call("HGET", sessionKey, "expiresAt"))
local profileGenerationKey = redis.call("HGET", sessionKey, "profileGenerationKey")
local managementGeneration = redis.call("HGET", sessionKey, "managementGeneration")
if not expiresAt or expiresAt <= now or not profileGenerationKey or not managementGeneration or
   redis.call("HGET", sessionKey, "pairingReplayKey") ~= KEYS[1] then
  deny(true)
  return { "denied" }
end
local generationType = redis.call("TYPE", profileGenerationKey)
if type(generationType) == "table" then generationType = generationType.ok end
if generationType ~= "none" and generationType ~= "string" then return { "state_collision" } end
local currentGeneration = generationType == "none" and "0" or redis.call("GET", profileGenerationKey)
if currentGeneration ~= managementGeneration then
  deny(true)
  return { "denied" }
end
local envelope = redis.call("HGET", KEYS[1], "authorityEnvelope")
if not envelope then return { "state_collision" } end
return { "replayed", envelope, tostring(expiresAt), tostring(replayExpiresAt) }
