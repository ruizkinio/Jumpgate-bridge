-- jg-script:management-pairing-issue
if #KEYS ~= 5 or #ARGV ~= 11 or
   not string.match(ARGV[6], "^[0-9]+$") or
   not string.match(ARGV[11], "^[0-9]+$") then
  return { "state_collision" }
end
local current = redis.call("TIME")
local now = (tonumber(current[1]) * 1000) + math.floor(tonumber(current[2]) / 1000)
redis.call("ZREMRANGEBYSCORE", KEYS[2], "-inf", now)
local generationType = redis.call("TYPE", KEYS[4])
if type(generationType) == "table" then generationType = generationType.ok end
if generationType ~= "none" and generationType ~= "string" then
  return { "state_collision" }
end
local generation = generationType == "none" and "0" or redis.call("GET", KEYS[4])
if generation ~= ARGV[6] then return { "profile_changed" } end

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

local function deny_replay(replayKey, denialExpiresAt, revokeSession)
  local sessionKey = redis.call("HGET", replayKey, "sessionKey")
  if revokeSession then remove_session(sessionKey) end
  redis.call("HSET", replayKey, "status", "denied", "deniedAt", tostring(now))
  redis.call("HDEL", replayKey, "authorityEnvelope", "sessionKey", "sessionExpiresAt")
  if denialExpiresAt and denialExpiresAt > now then
    redis.call("PEXPIREAT", replayKey, denialExpiresAt)
  else
    redis.call("DEL", replayKey)
  end
end

local replayType = redis.call("TYPE", KEYS[5])
if type(replayType) == "table" then replayType = replayType.ok end
if replayType ~= "none" and replayType ~= "hash" then return { "state_collision" } end
if replayType == "hash" then
  if redis.call("HGET", KEYS[5], "schemaVersion") ~= "1" then
    return { "state_collision" }
  end
  if redis.call("HGET", KEYS[5], "pairingHash") ~= ARGV[7] then
    return { "not_found" }
  end
  if redis.call("HGET", KEYS[5], "configHash") ~= ARGV[8] then
    return { "conflict" }
  end
  local denialExpiresAt = tonumber(redis.call("HGET", KEYS[5], "denialExpiresAt"))
  if not denialExpiresAt then return { "state_collision" } end
  if denialExpiresAt <= now then
    redis.call("DEL", KEYS[5])
    return { "denied" }
  end
  if redis.call("HGET", KEYS[5], "status") ~= "issued" then return { "denied" } end
  local replayExpiresAt = tonumber(redis.call("HGET", KEYS[5], "replayExpiresAt"))
  if not replayExpiresAt or replayExpiresAt <= now then
    deny_replay(KEYS[5], denialExpiresAt, false)
    return { "denied" }
  end
  local sessionKey = redis.call("HGET", KEYS[5], "sessionKey")
  if not sessionKey or redis.call("EXISTS", sessionKey) == 0 then
    deny_replay(KEYS[5], denialExpiresAt, true)
    return { "denied" }
  end
  local expiresAt = tonumber(redis.call("HGET", sessionKey, "expiresAt"))
  if not expiresAt or expiresAt <= now or
     redis.call("HGET", sessionKey, "pairingReplayKey") ~= KEYS[5] or
     redis.call("HGET", sessionKey, "profileGenerationKey") ~= KEYS[4] or
     redis.call("HGET", sessionKey, "managementGeneration") ~= ARGV[6] then
    deny_replay(KEYS[5], denialExpiresAt, true)
    return { "denied" }
  end
  local envelope = redis.call("HGET", KEYS[5], "authorityEnvelope")
  if not envelope then return { "state_collision" } end
  return { "replayed", envelope, tostring(expiresAt), tostring(replayExpiresAt) }
end

local suppliedRetryExpiry = tonumber(ARGV[11])
if suppliedRetryExpiry <= now then return { "denied" } end
redis.call("ZREMRANGEBYSCORE", KEYS[3], "-inf", now)
if redis.call("ZCARD", KEYS[2]) >= tonumber(ARGV[4]) then return { "global_capacity" } end
if redis.call("ZCARD", KEYS[3]) >= tonumber(ARGV[5]) then return { "profile_capacity" } end
if redis.call("EXISTS", KEYS[1]) == 1 then return { "collision" } end

local expiresAt = now + tonumber(ARGV[3])
local denialExpiresAt = math.min(suppliedRetryExpiry, now + tonumber(ARGV[10]))
local replayExpiresAt = math.min(denialExpiresAt, expiresAt)
if replayExpiresAt <= now then return { "denied" } end
redis.call("HSET", KEYS[1],
  "schemaVersion", "1",
  "profileId", ARGV[1],
  "managementGeneration", ARGV[6],
  "csrfHash", ARGV[2],
  "profileIndexKey", KEYS[3],
  "profileGenerationKey", KEYS[4],
  "pairingReplayKey", KEYS[5],
  "pairingReplayDenialExpiresAt", tostring(denialExpiresAt),
  "createdAt", tostring(now),
  "expiresAt", tostring(expiresAt))
redis.call("PEXPIREAT", KEYS[1], expiresAt)
redis.call("ZADD", KEYS[2], expiresAt, KEYS[1])
redis.call("ZADD", KEYS[3], expiresAt, KEYS[1])
local profileTtl = redis.call("PTTL", KEYS[3])
local requiredTtl = expiresAt - now
if profileTtl < requiredTtl then redis.call("PEXPIREAT", KEYS[3], expiresAt) end
redis.call("HSET", KEYS[5],
  "schemaVersion", "1",
  "status", "issued",
  "pairingHash", ARGV[7],
  "configHash", ARGV[8],
  "sessionKey", KEYS[1],
  "authorityEnvelope", ARGV[9],
  "sessionExpiresAt", tostring(expiresAt),
  "replayExpiresAt", tostring(replayExpiresAt),
  "denialExpiresAt", tostring(denialExpiresAt))
redis.call("PEXPIREAT", KEYS[5], denialExpiresAt)
return { "issued", ARGV[9], tostring(expiresAt), tostring(replayExpiresAt) }
