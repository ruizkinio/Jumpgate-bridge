-- jg-script:oauth-consume
if #KEYS ~= 3 or #ARGV ~= 6 or not string.match(ARGV[6], "^[0-9]+$") then
  return { "state_collision" }
end
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
if redis.call("HGET", KEYS[1], "bindingHash") ~= ARGV[1] then return { "binding_mismatch" } end
if redis.call("HGET", KEYS[1], "payloadEnvelope") ~= ARGV[2] or
   redis.call("HGET", KEYS[1], "profileId") ~= ARGV[3] or
   redis.call("HGET", KEYS[1], "createdAt") ~= ARGV[4] or
   tostring(expiresAt) ~= ARGV[5] or
   redis.call("HGET", KEYS[1], "managementGeneration") ~= ARGV[6] then
  return { "changed" }
end
local generationType = redis.call("TYPE", KEYS[3])
if type(generationType) == "table" then generationType = generationType.ok end
if generationType ~= "none" and generationType ~= "string" then return { "state_collision" } end
local managementGeneration = generationType == "none" and "0" or redis.call("GET", KEYS[3])
if managementGeneration ~= ARGV[6] then
  redis.call("DEL", KEYS[1])
  redis.call("ZREM", KEYS[2], KEYS[1])
  return { "profile_changed" }
end
redis.call("DEL", KEYS[1])
redis.call("ZREM", KEYS[2], KEYS[1])
return { "consumed" }
