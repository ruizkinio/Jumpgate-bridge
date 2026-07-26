-- jg-script:management-revoke
local current = redis.call("TIME")
local now = (tonumber(current[1]) * 1000) + math.floor(tonumber(current[2]) / 1000)
if redis.call("EXISTS", KEYS[1]) == 0 then
  redis.call("ZREM", KEYS[2], KEYS[1])
  return { "not_found" }
end
local profileIndexKey = redis.call("HGET", KEYS[1], "profileIndexKey")
local replayKey = redis.call("HGET", KEYS[1], "pairingReplayKey")
local denialExpiresAt = tonumber(redis.call("HGET", KEYS[1], "pairingReplayDenialExpiresAt"))
if replayKey and redis.call("EXISTS", replayKey) == 1 and
   redis.call("HGET", replayKey, "sessionKey") == KEYS[1] then
  redis.call("HSET", replayKey, "status", "denied", "deniedAt", tostring(now))
  redis.call("HDEL", replayKey, "authorityEnvelope", "sessionKey", "sessionExpiresAt")
  if denialExpiresAt and denialExpiresAt > now then
    redis.call("PEXPIREAT", replayKey, denialExpiresAt)
  else
    redis.call("DEL", replayKey)
  end
end
redis.call("DEL", KEYS[1])
redis.call("ZREM", KEYS[2], KEYS[1])
if profileIndexKey then redis.call("ZREM", profileIndexKey, KEYS[1]) end
return { "revoked" }
