-- jg-script:pairing-validation-v1
if redis.call("GET", KEYS[1]) ~= ARGV[1] then return { "not_found" } end
if redis.call("EXISTS", KEYS[2]) == 0 then
  redis.call("DEL", KEYS[1])
  return { "not_found" }
end
if redis.call("HGET", KEYS[2], "schemaVersion") ~= "2" or
   redis.call("HGET", KEYS[2], "pairingId") ~= ARGV[1] then return { "not_found" } end

local current = redis.call("TIME")
local now = (tonumber(current[1]) * 1000) + math.floor(tonumber(current[2]) / 1000)
local expiresAt = tonumber(redis.call("HGET", KEYS[2], "expiresAt"))
if not expiresAt or expiresAt <= now then return { "expired" } end
local scenario = redis.call("HGET", KEYS[2], "validationScenario")
if not scenario or scenario == "" then return { "none" } end
local rateLimitNow = "0"
if scenario == "rate-limit" and
   redis.call("HGET", KEYS[2], "validationRateLimitClaimed") ~= "1" then
  redis.call("HSET", KEYS[2], "validationRateLimitClaimed", "1")
  rateLimitNow = "1"
end
return { "scenario", scenario, rateLimitNow, tostring(expiresAt) }
