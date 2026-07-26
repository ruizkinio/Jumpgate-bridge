-- jg-script:management-revoke-profile
if #KEYS ~= 3 or #ARGV ~= 2 then return { "state_collision" } end
local current = redis.call("TIME")
local now = (tonumber(current[1]) * 1000) + math.floor(tonumber(current[2]) / 1000)
local maximum = tonumber(ARGV[2])
if not maximum or maximum < 1 or maximum > 100000 then return { "state_collision" } end
if redis.call("ZCARD", KEYS[2]) > maximum then return { "state_collision" } end
local generationType = redis.call("TYPE", KEYS[3])
if type(generationType) == "table" then generationType = generationType.ok end
if generationType ~= "none" and generationType ~= "string" then return { "state_collision" } end
local rawGeneration = generationType == "none" and "0" or redis.call("GET", KEYS[3])
local generation = nil
local nextGeneration = nil
local alreadyRevoked = false
if string.match(rawGeneration, "^[0-9]+$") and #rawGeneration <= 16 and
   tonumber(rawGeneration) < 9007199254740991 then
  generation = rawGeneration
  nextGeneration = tostring(tonumber(generation) + 1)
else
  local revokedGeneration = string.match(rawGeneration, "^revoked:([0-9]+)$")
  if not revokedGeneration or #revokedGeneration > 16 or
     tonumber(revokedGeneration) < 1 or tonumber(revokedGeneration) > 9007199254740991 then
    return { "state_collision" }
  end
  alreadyRevoked = true
  nextGeneration = revokedGeneration
  generation = tostring(tonumber(revokedGeneration) - 1)
end

local sessions = redis.call("ZRANGE", KEYS[2], 0, maximum - 1)
for _, sessionKey in ipairs(sessions) do
  local sessionType = redis.call("TYPE", sessionKey)
  if type(sessionType) == "table" then sessionType = sessionType.ok end
  if sessionType ~= "none" and sessionType ~= "hash" then return { "state_collision" } end
  local profileId = redis.call("HGET", sessionKey, "profileId")
  if profileId and profileId ~= ARGV[1] then return { "state_collision" } end
  if profileId and (
     redis.call("HGET", sessionKey, "schemaVersion") ~= "1" or
     redis.call("HGET", sessionKey, "profileIndexKey") ~= KEYS[2] or
     redis.call("HGET", sessionKey, "profileGenerationKey") ~= KEYS[3] or
     redis.call("HGET", sessionKey, "managementGeneration") ~= generation) then
    return { "state_collision" }
  end
end

if not alreadyRevoked then redis.call("SET", KEYS[3], "revoked:" .. nextGeneration) end
local revoked = 0
for _, sessionKey in ipairs(sessions) do
  if redis.call("HGET", sessionKey, "profileId") == ARGV[1] then
    local replayKey = redis.call("HGET", sessionKey, "pairingReplayKey")
    local denialExpiresAt = tonumber(
      redis.call("HGET", sessionKey, "pairingReplayDenialExpiresAt")
    )
    if replayKey and redis.call("EXISTS", replayKey) == 1 and
       redis.call("HGET", replayKey, "sessionKey") == sessionKey then
      redis.call("HSET", replayKey, "status", "denied", "deniedAt", tostring(now))
      redis.call("HDEL", replayKey, "authorityEnvelope", "sessionKey", "sessionExpiresAt")
      if denialExpiresAt and denialExpiresAt > now then
        redis.call("PEXPIREAT", replayKey, denialExpiresAt)
      else
        redis.call("DEL", replayKey)
      end
    end
    redis.call("DEL", sessionKey)
    redis.call("ZREM", KEYS[1], sessionKey)
    revoked = revoked + 1
  else
    redis.call("ZREM", KEYS[1], sessionKey)
  end
end
redis.call("DEL", KEYS[2])
return { "revoked", tostring(revoked), nextGeneration }
