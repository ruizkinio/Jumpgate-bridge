-- jg-script:oauth-consume-peek
local current = redis.call("TIME")
local now = (tonumber(current[1]) * 1000) + math.floor(tonumber(current[2]) / 1000)
if redis.call("EXISTS", KEYS[1]) == 0 then
  redis.call("ZREM", KEYS[2], KEYS[1])
  return { "not_found" }
end
local expiresAt = tonumber(redis.call("HGET", KEYS[1], "expiresAt"))
if expiresAt <= now then
  redis.call("DEL", KEYS[1])
  redis.call("ZREM", KEYS[2], KEYS[1])
  return { "not_found" }
end
if redis.call("HGET", KEYS[1], "bindingHash") ~= ARGV[1] then
  return { "binding_mismatch" }
end
local managementGeneration = redis.call("HGET", KEYS[1], "managementGeneration")
if not managementGeneration or not string.match(managementGeneration, "^[0-9]+$") or
   #managementGeneration > 16 then return { "state_collision" } end
return {
  "ready",
  redis.call("HGET", KEYS[1], "profileId"),
  redis.call("HGET", KEYS[1], "payloadEnvelope"),
  redis.call("HGET", KEYS[1], "createdAt"),
  tostring(expiresAt),
  managementGeneration
}
