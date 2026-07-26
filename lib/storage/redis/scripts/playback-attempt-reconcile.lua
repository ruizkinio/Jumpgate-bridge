-- jg-script:playback-attempt-reconcile-v1
local now = playback_now_ms()
local limit = tonumber(ARGV[1])
local expectedPrefix = ARGV[2]
local expectedFingerprintPrefix = ARGV[3]
if #KEYS ~= 3 or not limit or limit < 1 or limit > 256 or
   limit ~= math.floor(limit) or type(expectedPrefix) ~= "string" or
   #expectedPrefix < 1 or #expectedPrefix > 128 or
   type(expectedFingerprintPrefix) ~= "string" or
   #expectedFingerprintPrefix < 1 or #expectedFingerprintPrefix > 128 then
  return { "reconcile_invalid" }
end
for _, indexKey in ipairs(KEYS) do
  local indexType = playback_key_type(indexKey)
  if indexType ~= "none" and indexType ~= "zset" then return { "profile_collision" } end
end

local examined = 0
local released = 0
local expired = redis.call("ZRANGEBYSCORE", KEYS[1], "-inf", now, "LIMIT", 0, limit)
for _, attemptKey in ipairs(expired) do
  if string.sub(attemptKey, 1, #expectedPrefix) ~= expectedPrefix then
    return { "profile_collision" }
  end
  local record, recordError = playback_read_attempt(attemptKey)
  if recordError then return { recordError } end
  if record then
    redis.call("ZREM", record.profileAttemptsKey, attemptKey)
    if redis.call("GET", record.pointerKey) == attemptKey then redis.call("DEL", record.pointerKey) end
  end
  redis.call("DEL", attemptKey)
  redis.call("ZREM", KEYS[1], attemptKey)
  redis.call("ZREM", KEYS[2], attemptKey)
  examined = examined + 1
end

local expiredFingerprints = redis.call(
  "ZRANGEBYSCORE", KEYS[3], "-inf", now, "LIMIT", 0, limit
)
for _, fingerprintKey in ipairs(expiredFingerprints) do
  if string.sub(fingerprintKey, 1, #expectedFingerprintPrefix) ~= expectedFingerprintPrefix then
    return { "profile_collision" }
  end
  redis.call("DEL", fingerprintKey)
  redis.call("ZREM", KEYS[3], fingerprintKey)
end

local remaining = limit - examined
if remaining > 0 then
  local due = redis.call("ZRANGEBYSCORE", KEYS[2], "-inf", now, "LIMIT", 0, remaining)
  for _, attemptKey in ipairs(due) do
    if string.sub(attemptKey, 1, #expectedPrefix) ~= expectedPrefix then
      return { "profile_collision" }
    end
    local record, recordError = playback_read_attempt(attemptKey)
    if recordError then return { recordError } end
    if not record then
      redis.call("ZREM", KEYS[1], attemptKey)
      redis.call("ZREM", KEYS[2], attemptKey)
    elseif record.state ~= "pending" then
      redis.call("ZREM", KEYS[2], attemptKey)
    else
      local live, earliest, leaseError = playback_attempt_lease_summary(attemptKey, now, true)
      if leaseError then return { leaseError } end
      if live > 0 then
        redis.call("ZADD", KEYS[2], earliest, attemptKey)
      else
        local didRelease, releaseError = playback_attempt_release_claim(record)
        if releaseError then return { releaseError } end
        record.state = "abandoned"
        record.resultStatus = "not_found"
        redis.call("HSET", attemptKey, "record", cjson.encode(record))
        redis.call("ZREM", KEYS[2], attemptKey)
        if didRelease then released = released + 1 end
      end
    end
    examined = examined + 1
  end
end
local hasMore = redis.call("ZCOUNT", KEYS[1], "-inf", now) > 0 or
  redis.call("ZCOUNT", KEYS[2], "-inf", now) > 0 or
  redis.call("ZCOUNT", KEYS[3], "-inf", now) > 0
return { "reconciled", tostring(examined), tostring(released), hasMore and "1" or "0" }
