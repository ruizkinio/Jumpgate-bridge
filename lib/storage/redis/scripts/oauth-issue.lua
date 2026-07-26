-- jg-script:oauth-issue
if #KEYS ~= 3 or #ARGV ~= 6 or not string.match(ARGV[6], "^[0-9]+$") then
  return { "state_collision" }
end
local generationType = redis.call("TYPE", KEYS[3])
if type(generationType) == "table" then generationType = generationType.ok end
if generationType ~= "none" and generationType ~= "string" then return { "state_collision" } end
local managementGeneration = generationType == "none" and "0" or redis.call("GET", KEYS[3])
if managementGeneration ~= ARGV[6] then return { "profile_changed" } end
local current = redis.call("TIME")
local now = (tonumber(current[1]) * 1000) + math.floor(tonumber(current[2]) / 1000)
redis.call("ZREMRANGEBYSCORE", KEYS[2], "-inf", now)
if redis.call("EXISTS", KEYS[1]) == 1 then return { "collision" } end
if redis.call("ZCARD", KEYS[2]) >= tonumber(ARGV[5]) then return { "capacity" } end
local expiresAt = now + tonumber(ARGV[4])
redis.call("HSET", KEYS[1],
  "schemaVersion", "1",
  "profileId", ARGV[1],
  "managementGeneration", ARGV[6],
  "bindingHash", ARGV[2],
  "payloadEnvelope", ARGV[3],
  "createdAt", tostring(now),
  "expiresAt", tostring(expiresAt))
redis.call("PEXPIREAT", KEYS[1], expiresAt)
redis.call("ZADD", KEYS[2], expiresAt, KEYS[1])
return { "ok", tostring(expiresAt) }
