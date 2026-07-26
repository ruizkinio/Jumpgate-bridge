-- jg-script:management-issue
if #KEYS ~= 4 or #ARGV ~= 6 or not string.match(ARGV[6], "^[0-9]+$") then
  return { "state_collision" }
end
local generationType = redis.call("TYPE", KEYS[4])
if type(generationType) == "table" then generationType = generationType.ok end
if generationType ~= "none" and generationType ~= "string" then return { "state_collision" } end
local generation = generationType == "none" and "0" or redis.call("GET", KEYS[4])
if generation ~= ARGV[6] then return { "profile_changed" } end
local current = redis.call("TIME")
local now = (tonumber(current[1]) * 1000) + math.floor(tonumber(current[2]) / 1000)
redis.call("ZREMRANGEBYSCORE", KEYS[2], "-inf", now)
redis.call("ZREMRANGEBYSCORE", KEYS[3], "-inf", now)
if redis.call("ZCARD", KEYS[2]) >= tonumber(ARGV[4]) then return { "global_capacity" } end
if redis.call("ZCARD", KEYS[3]) >= tonumber(ARGV[5]) then return { "profile_capacity" } end
if redis.call("EXISTS", KEYS[1]) == 1 then return { "collision" } end

local expiresAt = now + tonumber(ARGV[3])
redis.call("HSET", KEYS[1],
  "schemaVersion", "1",
  "profileId", ARGV[1],
  "managementGeneration", ARGV[6],
  "csrfHash", ARGV[2],
  "profileIndexKey", KEYS[3],
  "profileGenerationKey", KEYS[4],
  "createdAt", tostring(now),
  "expiresAt", tostring(expiresAt))
redis.call("PEXPIREAT", KEYS[1], expiresAt)
redis.call("ZADD", KEYS[2], expiresAt, KEYS[1])
redis.call("ZADD", KEYS[3], expiresAt, KEYS[1])
local profileTtl = redis.call("PTTL", KEYS[3])
local requiredTtl = expiresAt - now
if profileTtl < requiredTtl then redis.call("PEXPIREAT", KEYS[3], expiresAt) end
return { "ok", tostring(expiresAt) }
