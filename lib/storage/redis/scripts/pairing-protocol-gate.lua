-- jg-script:pairing-protocol-gate-v2
if #KEYS ~= 1 or #ARGV ~= 1 or ARGV[1] ~= "pairing-replay-v2" then
  return { "state_collision" }
end
local keyType = redis.call("TYPE", KEYS[1])
if type(keyType) == "table" then keyType = keyType.ok end
if keyType == "none" then
  redis.call("SET", KEYS[1], ARGV[1])
  return { "ready" }
end
if keyType == "string" then
  if redis.call("GET", KEYS[1]) == ARGV[1] then return { "ready" } end
  return { "state_collision" }
end
if keyType ~= "zset" then return { "state_collision" } end

local current = redis.call("TIME")
local now = (tonumber(current[1]) * 1000) + math.floor(tonumber(current[2]) / 1000)
if redis.call("ZCOUNT", KEYS[1], "(" .. tostring(now), "+inf") > 0 then
  return { "legacy_active" }
end
redis.call("DEL", KEYS[1])
redis.call("SET", KEYS[1], ARGV[1])
return { "ready" }
