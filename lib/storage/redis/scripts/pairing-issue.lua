-- jg-script:pairing-issue-v2
local current = redis.call("TIME")
local now = (tonumber(current[1]) * 1000) + math.floor(tonumber(current[2]) / 1000)
local expiredRecords = redis.call(
  "ZRANGEBYSCORE", KEYS[4], "-inf", now, "LIMIT", 0, tonumber(ARGV[9])
)
for _, recordKey in ipairs(expiredRecords) do
  local pairingId = redis.call("HGET", recordKey, "pairingId")
  local expiresAt = tonumber(redis.call("HGET", recordKey, "expiresAt"))
  local state = redis.call("HGET", recordKey, "state")
  if pairingId and expiresAt and expiresAt <= now and
     state ~= "consumed" and state ~= "cancelled" and state ~= "expired" then
    local retainUntil = now + tonumber(ARGV[7])
    local userIndexKey = redis.call("HGET", recordKey, "userIndexKey")
    local deviceIndexKey = redis.call("HGET", recordKey, "deviceIndexKey")
    local retryIndexKey = redis.call("HGET", recordKey, "activationRetryIndexKey")
    local retryExpiresAt = tonumber(redis.call("HGET", recordKey, "activationRetryExpiresAt"))
    redis.call("HSET", recordKey, "state", "expired")
    if not retryExpiresAt or retryExpiresAt <= now then
      redis.call("HDEL", recordKey,
        "activationEnvelope", "activationDigest", "activationState", "finalizationHash")
    end
    if userIndexKey and redis.call("GET", userIndexKey) == pairingId then
      redis.call("DEL", userIndexKey)
    end
    if deviceIndexKey and redis.call("GET", deviceIndexKey) == pairingId then
      redis.call("PEXPIREAT", deviceIndexKey, retainUntil)
    end
    if retryIndexKey and retryExpiresAt and retryExpiresAt > now then
      redis.call("PEXPIREAT", retryIndexKey, retryExpiresAt)
      retainUntil = math.max(retainUntil, retryExpiresAt)
    end
    redis.call("PEXPIREAT", recordKey, retainUntil)
  end
  redis.call("ZREM", KEYS[4], recordKey)
end

if redis.call("EXISTS", KEYS[1]) == 1 then return { "id_collision" } end
if redis.call("EXISTS", KEYS[2]) == 1 or redis.call("EXISTS", KEYS[3]) == 1 then
  return { "code_collision" }
end
local activeCount = redis.call("ZCOUNT", KEYS[4], "(" .. tostring(now), "+inf")
if activeCount >= tonumber(ARGV[8]) then return { "capacity" } end

local expiresAt = now + tonumber(ARGV[6])
local physicalExpiry = expiresAt + tonumber(ARGV[7])
redis.call("HSET", KEYS[1],
  "schemaVersion", "2",
  "pairingId", ARGV[1],
  "deviceId", ARGV[2],
  "deviceName", ARGV[3],
  "userCodeHash", ARGV[4],
  "deviceCodeHash", ARGV[5],
  "userIndexKey", KEYS[2],
  "deviceIndexKey", KEYS[3],
  "state", "pending",
  "createdAt", tostring(now),
  "expiresAt", tostring(expiresAt))
if ARGV[10] ~= "" then
  redis.call("HSET", KEYS[1],
    "validationScenario", ARGV[10],
    "validationRateLimitClaimed", "0")
end
redis.call("SET", KEYS[2], ARGV[1])
redis.call("SET", KEYS[3], ARGV[1])
redis.call("PEXPIREAT", KEYS[2], physicalExpiry)
redis.call("PEXPIREAT", KEYS[3], physicalExpiry)
redis.call("PEXPIREAT", KEYS[1], physicalExpiry)
redis.call("ZADD", KEYS[4], expiresAt, KEYS[1])
return { "ok", tostring(expiresAt) }
