-- jg-script:playback-attempt-begin-v3
local now = playback_now_ms()

local function playback_valid_canonical_uuid(value)
  if type(value) ~= "string" or #value ~= 36 or
     string.sub(value, 9, 9) ~= "-" or string.sub(value, 14, 14) ~= "-" or
     string.sub(value, 19, 19) ~= "-" or string.sub(value, 24, 24) ~= "-" or
     not string.match(string.sub(value, 15, 15), "^[1-8]$") or
     not string.match(string.sub(value, 20, 20), "^[89ab]$") then return false end
  local compact = string.gsub(value, "-", "")
  return #compact == 32 and string.match(compact, "^[0-9a-f]+$") ~= nil
end

if #KEYS ~= 12 or
   not playback_valid_digest(ARGV[1], false) or
   not playback_valid_digest(ARGV[2], false) or
   not playback_valid_digest(ARGV[3], false) or
   not playback_valid_decimal(ARGV[4], 16) or
   not playback_valid_digest(ARGV[5], false) or
   not playback_valid_identifier(ARGV[6], false) or
   not playback_valid_generation(ARGV[7]) or
   not playback_valid_device_generation(ARGV[8]) or
   not playback_valid_digest(ARGV[9], false) or
   not playback_valid_canonical_uuid(ARGV[15]) or
   not playback_valid_digest(ARGV[16], false) then return { "profile_collision" } end

local leaseTtlMs = tonumber(ARGV[10])
local attemptTtlMs = tonumber(ARGV[11])
local maxGlobal = tonumber(ARGV[12])
local maxProfile = tonumber(ARGV[13])
local maxLeases = tonumber(ARGV[14])
if not leaseTtlMs or leaseTtlMs < 1 or leaseTtlMs > 300000 or
   leaseTtlMs ~= math.floor(leaseTtlMs) or
   not attemptTtlMs or attemptTtlMs < leaseTtlMs or attemptTtlMs > 604800000 or
   attemptTtlMs ~= math.floor(attemptTtlMs) or
   not maxGlobal or maxGlobal < 1 or maxGlobal > 100000 or
   maxGlobal ~= math.floor(maxGlobal) or
   not maxProfile or maxProfile < 1 or maxProfile > 100000 or
   maxProfile ~= math.floor(maxProfile) or
   not maxLeases or maxLeases < 1 or maxLeases > 64 or
   maxLeases ~= math.floor(maxLeases) then return { "profile_collision" } end

if playback_key_type(KEYS[6]) ~= "string" or redis.call("GET", KEYS[6]) ~= ARGV[7] then
  return { "generation_changed" }
end
local deviceType = playback_key_type(KEYS[7])
if deviceType ~= "none" and deviceType ~= "string" then return { "profile_collision" } end
if deviceType == "string" then
  local currentDeviceGeneration = redis.call("GET", KEYS[7])
  if not playback_valid_device_generation(currentDeviceGeneration) then
    return { "profile_collision" }
  end
  if currentDeviceGeneration ~= ARGV[8] then return { "device_generation_changed" } end
end
for _, indexKey in ipairs({ KEYS[3], KEYS[4], KEYS[5], KEYS[12] }) do
  local indexType = playback_key_type(indexKey)
  if indexType ~= "none" and indexType ~= "zset" then return { "profile_collision" } end
end
local fingerprintBindingType = playback_key_type(KEYS[11])
if fingerprintBindingType ~= "none" and fingerprintBindingType ~= "string" then
  return { "profile_collision" }
end

local function pruneIndex(indexKey)
  local expired = redis.call("ZRANGEBYSCORE", indexKey, "-inf", now, "LIMIT", 0, 256)
  if #expired > 0 then redis.call("ZREM", indexKey, unpack(expired)) end
end
pruneIndex(KEYS[3])
pruneIndex(KEYS[4])
pruneIndex(KEYS[12])

local record, recordError = playback_read_attempt(KEYS[1])
if recordError then return { recordError } end
if record and (tonumber(record.authorityExpiresAtMs) <= now or
   record.generation ~= ARGV[7] or record.deviceGeneration ~= ARGV[8]) then
  redis.call("ZREM", KEYS[3], KEYS[1])
  redis.call("ZREM", record.profileAttemptsKey, KEYS[1])
  redis.call("ZREM", KEYS[5], KEYS[1])
  redis.call("ZREM", KEYS[12], KEYS[11])
  if redis.call("GET", record.pointerKey) == KEYS[1] then redis.call("DEL", record.pointerKey) end
  redis.call("DEL", KEYS[1], KEYS[11])
  record = nil
end

if record then
  if record.profileTag ~= ARGV[1] or record.deviceRef ~= ARGV[2] or
     record.intentUrlHash ~= ARGV[3] or record.launchedAtMs ~= ARGV[4] or
     record.requestDigest ~= ARGV[5] or record.sessionId ~= ARGV[6] or
     record.generation ~= ARGV[7] or record.deviceGeneration ~= ARGV[8] or
     record.claimsKey ~= KEYS[8] or record.sessionKey ~= KEYS[9] or
     record.pointerKey ~= KEYS[2] or record.rootKey ~= KEYS[10] or
     record.profileAttemptsKey ~= KEYS[4] then
    return { "claim_request_conflict" }
  end
  if redis.call("GET", KEYS[11]) ~= ARGV[16] then
    return { "claim_request_conflict" }
  end
  if not redis.call("ZSCORE", KEYS[12], KEYS[11]) then return { "profile_collision" } end
  if redis.call("GET", KEYS[2]) ~= KEYS[1] then return { "profile_collision" } end
  if record.state == "disclosed" then return { "disclosed" } end
  if record.state == "abandoned" then return { "abandoned" } end
  local live, earliest, leaseError = playback_attempt_lease_summary(KEYS[1], now, true)
  if leaseError then return { leaseError } end
  if live == 0 and record.resultStatus ~= "pending" then
    local _, releaseError = playback_attempt_release_claim(record)
    if releaseError then return { releaseError } end
    record.state = "abandoned"
    record.resultStatus = "not_found"
    redis.call("HSET", KEYS[1], "record", cjson.encode(record))
    redis.call("ZREM", KEYS[5], KEYS[1])
    return { "abandoned" }
  end
  if live >= maxLeases then return { "attempt_capacity" } end
  local leaseDeadline = now + leaseTtlMs
  redis.call("HSET", KEYS[1], "lease:" .. ARGV[9], tostring(leaseDeadline))
  if not earliest or leaseDeadline < earliest then earliest = leaseDeadline end
  redis.call("ZADD", KEYS[5], earliest, KEYS[1])
  return { "retry" }
end

if redis.call("ZCARD", KEYS[3]) >= maxGlobal or
   redis.call("ZCARD", KEYS[12]) >= maxGlobal or
   redis.call("ZCARD", KEYS[4]) >= maxProfile then return { "attempt_capacity" } end
local pointerType = playback_key_type(KEYS[2])
if pointerType ~= "none" then return { "session_collision" } end
local authorityExpiresAtMs = now + attemptTtlMs
local leaseDeadline = now + leaseTtlMs
record = {
  v = "1",
  profileTag = ARGV[1],
  deviceRef = ARGV[2],
  intentUrlHash = ARGV[3],
  launchedAtMs = ARGV[4],
  requestDigest = ARGV[5],
  sessionId = ARGV[6],
  generation = ARGV[7],
  deviceGeneration = ARGV[8],
  state = "pending",
  resultStatus = "pending",
  authorityExpiresAtMs = tostring(authorityExpiresAtMs),
  claimsKey = KEYS[8],
  sessionKey = KEYS[9],
  pointerKey = KEYS[2],
  rootKey = KEYS[10],
  profileAttemptsKey = KEYS[4]
}
redis.call("HSET", KEYS[1], "record", cjson.encode(record))
redis.call("HSET", KEYS[1], "lease:" .. ARGV[9], tostring(leaseDeadline))
redis.call("SET", KEYS[11], ARGV[16])
redis.call("SET", KEYS[2], KEYS[1])
redis.call("ZADD", KEYS[3], authorityExpiresAtMs, KEYS[1])
redis.call("ZADD", KEYS[4], authorityExpiresAtMs, KEYS[1])
redis.call("ZADD", KEYS[5], leaseDeadline, KEYS[1])
redis.call("ZADD", KEYS[12], authorityExpiresAtMs, KEYS[11])
redis.call("PEXPIREAT", KEYS[1], authorityExpiresAtMs)
redis.call("PEXPIREAT", KEYS[2], authorityExpiresAtMs)
redis.call("PEXPIREAT", KEYS[11], authorityExpiresAtMs)
playback_preserve_max_expiry(KEYS[4], authorityExpiresAtMs)
return { "begun" }
