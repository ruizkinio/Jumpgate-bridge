-- jg-script:management-pairing-revoke
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
if redis.call("HGET", KEYS[1], "status") ~= "issued" then return { "denied" } end
local sessionKey = redis.call("HGET", KEYS[1], "sessionKey")
if sessionKey then
  local profileIndexKey = nil
  if redis.call("EXISTS", sessionKey) == 1 then
    profileIndexKey = redis.call("HGET", sessionKey, "profileIndexKey")
    redis.call("DEL", sessionKey)
  end
  redis.call("ZREM", KEYS[2], sessionKey)
  if profileIndexKey then redis.call("ZREM", profileIndexKey, sessionKey) end
end
local denialExpiresAt = tonumber(redis.call("HGET", KEYS[1], "denialExpiresAt"))
redis.call("HSET", KEYS[1], "status", "denied", "deniedAt", tostring(now))
redis.call("HDEL", KEYS[1], "authorityEnvelope", "sessionKey", "sessionExpiresAt")
if denialExpiresAt and denialExpiresAt > now then
  redis.call("PEXPIREAT", KEYS[1], denialExpiresAt)
else
  redis.call("DEL", KEYS[1])
end
return { "revoked" }
