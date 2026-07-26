-- Playback payloads are opaque encrypted envelopes. Lua decodes only bounded,
-- secret-free metadata whose integer values are decimal strings.

local function playback_decode_json(raw)
  local ok, value = pcall(cjson.decode, raw)
  if not ok then return nil end
  return value
end

local function playback_now_ms()
  local current = redis.call("TIME")
  return (tonumber(current[1]) * 1000) + math.floor(tonumber(current[2]) / 1000)
end

local function playback_key_type(key)
  local reply = redis.call("TYPE", key)
  if type(reply) == "table" then return reply.ok end
  return reply
end

local function playback_preserve_max_expiry(key, expiresAtMs)
  local currentExpiresAtMs = redis.call("PEXPIRETIME", key)
  if currentExpiresAtMs == -1 or
     (currentExpiresAtMs >= 0 and expiresAtMs > currentExpiresAtMs) then
    redis.call("PEXPIREAT", key, expiresAtMs)
  end
end

local function playback_is_object(value)
  if type(value) ~= "table" then return false end
  for key, _ in pairs(value) do
    if type(key) ~= "string" then return false end
  end
  return true
end

local function playback_is_array(value)
  if type(value) ~= "table" then return false end
  local count = 0
  local highest = 0
  for key, _ in pairs(value) do
    if type(key) ~= "number" or key < 1 or key ~= math.floor(key) then return false end
    count = count + 1
    if key > highest then highest = key end
  end
  return count > 0 and highest == count
end

local function playback_valid_digest(value, allowEmpty)
  if allowEmpty and value == "" then return true end
  return type(value) == "string" and #value == 64 and
    string.match(value, "^[a-f0-9]+$") ~= nil
end

local function playback_valid_identifier(value, allowEmpty)
  if allowEmpty and value == "" then return true end
  return type(value) == "string" and #value >= 1 and #value <= 256 and
    string.match(value, "^[^%c]+$") ~= nil and
    string.match(value, "^%s") == nil and string.match(value, "%s$") == nil
end

local function playback_valid_generation(value)
  return type(value) == "string" and #value >= 4 and #value <= 131 and
    string.match(value, "^g1:[A-Za-z0-9_-]+$") ~= nil
end

local function playback_pending_generation_deadline(value)
  if not playback_valid_generation(value) then return nil end
  local deadline, nonce = string.match(value, "^g1:w_([0-9]+)_([A-Za-z0-9_-]+)$")
  if not deadline or #deadline > 16 or #nonce ~= 43 then return nil end
  return tonumber(deadline)
end

local function playback_valid_decimal(value, maximumLength)
  if type(value) ~= "string" or #value < 1 or #value > maximumLength then return false end
  return value == "0" or string.match(value, "^[1-9][0-9]*$") ~= nil
end

local function playback_decimal_increment(value)
  if not playback_valid_decimal(value, 128) then return nil end
  local output = {}
  local carry = 1
  for index = #value, 1, -1 do
    local digit = string.byte(value, index) - 48 + carry
    if digit >= 10 then
      digit = digit - 10
      carry = 1
    else
      carry = 0
    end
    table.insert(output, 1, string.char(48 + digit))
  end
  if carry == 1 then table.insert(output, 1, "1") end
  local result = table.concat(output)
  if #result > 128 then return nil end
  return result
end

local function playback_decimal_compare(left, right)
  if not playback_valid_decimal(left, 128) or not playback_valid_decimal(right, 128) then return nil end
  if #left < #right then return -1 end
  if #left > #right then return 1 end
  if left < right then return -1 end
  if left > right then return 1 end
  return 0
end

local function playback_valid_device_generation(value)
  return playback_valid_decimal(value, 16) and
    playback_decimal_compare(value, "1") >= 0 and
    playback_decimal_compare(value, "9007199254740991") <= 0
end

local function playback_device_generation_matches(key, expected, initialize)
  if not playback_valid_device_generation(expected) then return nil, "profile_collision" end
  local keyType = playback_key_type(key)
  if keyType == "none" then
    if not initialize then return false, nil end
    redis.call("SET", key, expected)
    return true, nil
  end
  if keyType ~= "string" then return nil, "profile_collision" end
  local current = redis.call("GET", key)
  if not playback_valid_device_generation(current) then return nil, "profile_collision" end
  return current == expected, nil
end

local function playback_advance_device_generation(key, nextGeneration)
  if not playback_valid_device_generation(nextGeneration) then
    return nil, "profile_collision"
  end
  local keyType = playback_key_type(key)
  if keyType == "none" then
    redis.call("SET", key, nextGeneration)
    return true, nil
  end
  if keyType ~= "string" then return nil, "profile_collision" end
  local current = redis.call("GET", key)
  local comparison = playback_decimal_compare(current, nextGeneration)
  if comparison == nil then return nil, "profile_collision" end
  if comparison > 0 then return nil, "device_generation_changed" end
  if comparison == 0 then return false, nil end
  redis.call("SET", key, nextGeneration)
  return true, nil
end

local function playback_track_device_generation(
  deviceGenerationIndex,
  deviceGenerationKey,
  now,
  ttlMs,
  maximum
)
  if playback_key_type(deviceGenerationKey) ~= "string" or
     not playback_valid_device_generation(redis.call("GET", deviceGenerationKey)) then
    return "profile_collision"
  end
  local indexType = playback_key_type(deviceGenerationIndex)
  if indexType ~= "none" and indexType ~= "zset" then return "profile_collision" end
  local boundedTtl = tonumber(ttlMs)
  local boundedMaximum = tonumber(maximum)
  if not boundedTtl or boundedTtl < 1 or boundedTtl > 604800000 or
     boundedTtl ~= math.floor(boundedTtl) or not boundedMaximum or
     boundedMaximum < 1 or boundedMaximum > 100000 or
     boundedMaximum ~= math.floor(boundedMaximum) then return "profile_collision" end

  redis.call("ZREMRANGEBYSCORE", deviceGenerationIndex, "-inf", now)
  if not redis.call("ZSCORE", deviceGenerationIndex, deviceGenerationKey) then
    local tracked = redis.call("ZCARD", deviceGenerationIndex)
    if tracked > boundedMaximum then return "profile_collision" end
    if tracked == boundedMaximum then
      -- Index members are untrusted addresses. Forget one bounded entry but
      -- never dereference it for deletion; generation keys expire by TTL.
      redis.call("ZREMRANGEBYRANK", deviceGenerationIndex, 0, 0)
    end
  end

  local expiresAt = now + boundedTtl
  redis.call("ZADD", deviceGenerationIndex, expiresAt, deviceGenerationKey)
  redis.call("PEXPIREAT", deviceGenerationKey, expiresAt)
  local last = redis.call("ZREVRANGE", deviceGenerationIndex, 0, 0, "WITHSCORES")
  if #last == 2 then redis.call("PEXPIREAT", deviceGenerationIndex, tonumber(last[2])) end
  return nil
end

local function playback_delete_device_generations(deviceGenerationIndex)
  local indexType = playback_key_type(deviceGenerationIndex)
  if indexType == "none" then return nil end
  if indexType ~= "zset" then return "profile_collision" end
  -- Members can be poisoned with arbitrary Redis keys. The trusted index may
  -- be removed atomically; member keys retain their independently bounded TTL.
  redis.call("DEL", deviceGenerationIndex)
  return nil
end

local function playback_valid_string_array(value, maximum, digest)
  if not playback_is_array(value) or #value < 1 or #value > maximum then return false end
  local seen = {}
  for _, item in ipairs(value) do
    if type(item) ~= "string" or #item < 1 or #item > 512 or seen[item] then return false end
    if digest and not playback_valid_digest(item, false) then return false end
    seen[item] = true
  end
  return true
end

local playback_context_fields = {
  v = true,
  ref = true,
  globalMember = true,
  equivalenceHash = true,
  fingerprintHashes = true,
  fingerprintIndexKeys = true,
  tombstoneMembers = true,
  generation = true,
  revision = true,
  providerRevision = true,
  createdAtMs = true,
  expiresAtMs = true,
  envelope = true
}

local function playback_decode_context_metadata(raw)
  local value = playback_decode_json(raw)
  if not playback_is_object(value) then return nil end
  local count = 0
  for key, _ in pairs(value) do
    count = count + 1
    if not playback_context_fields[key] then return nil end
  end
  local expectedCount = nil
  if value.v == "3" and value.providerRevision == nil then
    expectedCount = 12
  elseif value.v == "4" and playback_valid_decimal(value.providerRevision, 128) then
    expectedCount = 13
  end
  if count ~= expectedCount or
     not playback_valid_digest(value.ref, false) or
     not playback_valid_digest(value.globalMember, false) or
     not playback_valid_digest(value.equivalenceHash, true) or
     not playback_valid_generation(value.generation) or
     not playback_valid_decimal(value.revision, 128) or
     not playback_valid_decimal(value.createdAtMs, 16) or
     not playback_valid_decimal(value.expiresAtMs, 16) or
     type(value.envelope) ~= "string" or #value.envelope < 2 or #value.envelope > 2097152 then
    return nil
  end
  if not playback_valid_string_array(value.fingerprintHashes, 32, true) or
     not playback_valid_string_array(value.fingerprintIndexKeys, 32, false) or
     not playback_valid_string_array(value.tombstoneMembers, 32, true) or
     #value.fingerprintHashes ~= #value.fingerprintIndexKeys or
     #value.fingerprintHashes ~= #value.tombstoneMembers then return nil end
  local createdAtMs = tonumber(value.createdAtMs)
  local expiresAtMs = tonumber(value.expiresAtMs)
  if not createdAtMs or not expiresAtMs or expiresAtMs <= createdAtMs then return nil end
  return value
end

local playback_claim_fields = {
  v = true,
  deviceRef = true,
  intentUrlHash = true,
  launchedAtMs = true,
  expiresAtMs = true,
  status = true,
  globalMember = true,
  released = true,
  contextRef = true,
  sessionId = true,
  sessionKey = true,
  claimedAtMs = true,
  privateStateEnvelope = true,
  cleanupOwner = true,
  authorityVersion = true,
  requestDigest = true
}

local function playback_decode_claim(raw)
  local value = playback_decode_json(raw)
  if not playback_is_object(value) then return nil end
  local count = 0
  for key, _ in pairs(value) do
    count = count + 1
    if not playback_claim_fields[key] then return nil end
  end
  if (value.v ~= "3" and value.v ~= "4") or
     not playback_valid_digest(value.deviceRef, false) or
     not playback_valid_digest(value.intentUrlHash, false) or
     not playback_valid_digest(value.globalMember, false) or
     not playback_valid_decimal(value.launchedAtMs, 16) or
     not playback_valid_decimal(value.expiresAtMs, 16) or
     (value.released ~= "0" and value.released ~= "1") then return nil end
  local hasV5Authority = value.authorityVersion == "5"
  if hasV5Authority then
    if value.v ~= "4" or
       not playback_valid_digest(value.requestDigest, false) or
       not playback_valid_identifier(value.sessionId, false) then return nil end
  elseif value.authorityVersion ~= nil or value.requestDigest ~= nil then
    return nil
  end
  if value.status ~= "claimed" and value.status ~= "ambiguous" and
     value.status ~= "expired" and value.status ~= "not_found" then return nil end
  if value.status == "claimed" then
    local expectedCount = value.v == "3" and 12 or
      (hasV5Authority and 15 or (value.cleanupOwner == nil and 13 or 14))
    if count ~= expectedCount then return nil end
    if not playback_valid_digest(value.contextRef, false) or
       not playback_valid_identifier(value.sessionId, false) or
       type(value.sessionKey) ~= "string" or #value.sessionKey < 1 or #value.sessionKey > 512 or
       not playback_valid_decimal(value.claimedAtMs, 16) then return nil end
    if value.v == "3" then
      if value.privateStateEnvelope ~= nil or value.cleanupOwner ~= nil then return nil end
    elseif type(value.privateStateEnvelope) ~= "string" or
           #value.privateStateEnvelope < 2 or #value.privateStateEnvelope > 8192 then
      return nil
    elseif (hasV5Authority and value.cleanupOwner ~= nil) or
           (not hasV5Authority and value.cleanupOwner ~= nil and
            not playback_valid_identifier(value.cleanupOwner, false)) then
      return nil
    end
  else
    local expectedCount = hasV5Authority and 11 or 8
    if count ~= expectedCount or value.contextRef ~= nil or
       (not hasV5Authority and value.sessionId ~= nil) or
       value.sessionKey ~= nil or value.claimedAtMs ~= nil or
       value.privateStateEnvelope ~= nil or value.cleanupOwner ~= nil then return nil end
  end
  return value
end

local playback_attempt_record_fields = {
  v = true,
  profileTag = true,
  deviceRef = true,
  intentUrlHash = true,
  launchedAtMs = true,
  requestDigest = true,
  sessionId = true,
  generation = true,
  deviceGeneration = true,
  state = true,
  resultStatus = true,
  authorityExpiresAtMs = true,
  claimsKey = true,
  sessionKey = true,
  pointerKey = true,
  rootKey = true,
  profileAttemptsKey = true
}

local function playback_valid_redis_key(value)
  return type(value) == "string" and #value >= 1 and #value <= 512 and
    not string.find(value, "[%z\1-\31\127]")
end

local function playback_decode_attempt_record(raw)
  local value = playback_decode_json(raw)
  if not playback_is_object(value) then return nil end
  local count = 0
  for key, _ in pairs(value) do
    count = count + 1
    if not playback_attempt_record_fields[key] then return nil end
  end
  if count ~= 17 or value.v ~= "1" or
     not playback_valid_digest(value.profileTag, false) or
     not playback_valid_digest(value.deviceRef, false) or
     not playback_valid_digest(value.intentUrlHash, false) or
     not playback_valid_decimal(value.launchedAtMs, 16) or
     not playback_valid_digest(value.requestDigest, false) or
     not playback_valid_identifier(value.sessionId, false) or
     not playback_valid_generation(value.generation) or
     not playback_valid_device_generation(value.deviceGeneration) or
     not playback_valid_decimal(value.authorityExpiresAtMs, 16) or
     not playback_valid_redis_key(value.claimsKey) or
     not playback_valid_redis_key(value.sessionKey) or
     not playback_valid_redis_key(value.pointerKey) or
     not playback_valid_redis_key(value.rootKey) or
     not playback_valid_redis_key(value.profileAttemptsKey) then return nil end
  if value.state ~= "pending" and value.state ~= "disclosed" and
     value.state ~= "abandoned" then return nil end
  if value.resultStatus ~= "pending" and value.resultStatus ~= "claimed" and
     value.resultStatus ~= "ambiguous" and value.resultStatus ~= "expired" and
     value.resultStatus ~= "not_found" then return nil end
  if value.state ~= "pending" and value.resultStatus == "pending" then return nil end
  return value
end

local function playback_read_attempt(attemptKey)
  local keyType = playback_key_type(attemptKey)
  if keyType == "none" then return nil, nil end
  if keyType ~= "hash" then return nil, "profile_collision" end
  local raw = redis.call("HGET", attemptKey, "record")
  local record = raw and playback_decode_attempt_record(raw) or nil
  if not record then return nil, "profile_collision" end
  return record, nil
end

local function playback_attempt_lease_summary(attemptKey, now, removeExpired)
  local live = 0
  local earliest = nil
  for _, field in ipairs(redis.call("HKEYS", attemptKey)) do
    if field ~= "record" then
      local leaseHash = string.match(field, "^lease:([a-f0-9]+)$")
      local deadline = leaseHash and redis.call("HGET", attemptKey, field) or nil
      if not leaseHash or #leaseHash ~= 64 or
         not playback_valid_decimal(deadline, 16) then return nil, nil, "profile_collision" end
      local numericDeadline = tonumber(deadline)
      if numericDeadline <= now and removeExpired then
        redis.call("HDEL", attemptKey, field)
      elseif numericDeadline > now then
        live = live + 1
        if not earliest or numericDeadline < earliest then earliest = numericDeadline end
      end
    end
  end
  return live, earliest, nil
end

local function playback_attempt_clear_leases(attemptKey)
  local fields = {}
  for _, field in ipairs(redis.call("HKEYS", attemptKey)) do
    if field ~= "record" then table.insert(fields, field) end
  end
  if #fields > 0 then redis.call("HDEL", attemptKey, unpack(fields)) end
end

local function playback_attempt_release_claim(record)
  local raw = redis.call("HGET", record.claimsKey, record.deviceRef)
  if not raw then return false, nil end
  local claim = playback_decode_claim(raw)
  if not claim then return false, "profile_collision" end
  if claim.authorityVersion ~= "5" or claim.requestDigest ~= record.requestDigest or
     claim.sessionId ~= record.sessionId or claim.intentUrlHash ~= record.intentUrlHash or
     claim.launchedAtMs ~= record.launchedAtMs or claim.status ~= "claimed" or
     claim.released ~= "0" then return false, nil end
  claim.released = "1"
  redis.call("HSET", record.claimsKey, record.deviceRef, cjson.encode(claim))
  if claim.sessionKey == record.sessionKey and redis.call("GET", record.sessionKey) == record.rootKey then
    redis.call("DEL", record.sessionKey)
  end
  return true, nil
end

local function playback_attempt_finalize(
  attemptKey,
  globalAttempts,
  profileAttempts,
  reconcileIndex,
  status,
  expiresAtMs
)
  local record, recordError = playback_read_attempt(attemptKey)
  if recordError then return recordError end
  if not record then return "claim_attempt_changed" end
  local numericExpiry = tonumber(expiresAtMs)
  if not numericExpiry then return "profile_collision" end
  record.resultStatus = status
  if status ~= "claimed" then
    record.state = "disclosed"
    playback_attempt_clear_leases(attemptKey)
    redis.call("ZREM", reconcileIndex, attemptKey)
  end
  if numericExpiry > tonumber(record.authorityExpiresAtMs) then
    record.authorityExpiresAtMs = tostring(numericExpiry)
  end
  local profileAttemptsType = playback_key_type(profileAttempts)
  if profileAttemptsType ~= "none" and profileAttemptsType ~= "zset" then
    return "profile_collision"
  end
  redis.call("HSET", attemptKey, "record", cjson.encode(record))
  redis.call("ZADD", globalAttempts, tonumber(record.authorityExpiresAtMs), attemptKey)
  redis.call("ZADD", profileAttempts, tonumber(record.authorityExpiresAtMs), attemptKey)
  redis.call("PEXPIREAT", attemptKey, tonumber(record.authorityExpiresAtMs))
  redis.call("PEXPIREAT", record.pointerKey, tonumber(record.authorityExpiresAtMs))
  playback_preserve_max_expiry(
    profileAttempts,
    tonumber(record.authorityExpiresAtMs)
  )
  return nil
end

local function playback_profile_keys(source)
  return {
    root = source[1],
    contexts = source[2],
    contextExpiries = source[3],
    contextOrder = source[4],
    equivalences = source[5],
    claims = source[6],
    claimExpiries = source[7],
    claimOrder = source[8],
    tombstones = source[9],
    tombstoneGlobals = source[10],
    tombstoneOrder = source[11],
    globalContexts = source[12],
    globalClaims = source[13],
    globalTombstones = source[14],
    schedule = source[15],
    generation = source[16]
  }
end

local playback_profile_root_fields = {
  { "contextsKey", "contexts" },
  { "contextExpiriesKey", "contextExpiries" },
  { "contextOrderKey", "contextOrder" },
  { "equivalencesKey", "equivalences" },
  { "claimsKey", "claims" },
  { "claimExpiriesKey", "claimExpiries" },
  { "claimOrderKey", "claimOrder" },
  { "tombstonesKey", "tombstones" },
  { "tombstoneGlobalsKey", "tombstoneGlobals" },
  { "tombstoneOrderKey", "tombstoneOrder" },
  { "generationKey", "generation" }
}

local function playback_current_generation(keys)
  local value = redis.call("GET", keys.generation)
  if not value or not playback_valid_generation(value) then return nil end
  return value
end

local function playback_ensure_profile(keys, expectedProfileTag, create)
  local rootType = playback_key_type(keys.root)
  if rootType == "none" then
    if not create then return false, "not_found" end
    if not playback_current_generation(keys) then return false, "generation_changed" end
    local fields = { "schemaVersion", "3", "profileTag", expectedProfileTag }
    for _, mapping in ipairs(playback_profile_root_fields) do
      table.insert(fields, mapping[1])
      table.insert(fields, keys[mapping[2]])
    end
    redis.call("HSET", keys.root, unpack(fields))
    return true, nil
  end
  if rootType ~= "hash" or redis.call("HGET", keys.root, "schemaVersion") ~= "3" or
     redis.call("HGET", keys.root, "profileTag") ~= expectedProfileTag then
    return false, "profile_collision"
  end
  for _, mapping in ipairs(playback_profile_root_fields) do
    if redis.call("HGET", keys.root, mapping[1]) ~= keys[mapping[2]] then
      return false, "profile_collision"
    end
  end
  return true, nil
end

local function playback_load_scheduled_profile(rootKey, globalContexts, globalClaims, globalTombstones, schedule)
  if playback_key_type(rootKey) ~= "hash" or redis.call("HGET", rootKey, "schemaVersion") ~= "3" then
    return nil
  end
  local keys = {
    root = rootKey,
    globalContexts = globalContexts,
    globalClaims = globalClaims,
    globalTombstones = globalTombstones,
    schedule = schedule
  }
  for _, mapping in ipairs(playback_profile_root_fields) do
    local value = redis.call("HGET", rootKey, mapping[1])
    if not value or value == "" then return nil end
    keys[mapping[2]] = value
  end
  if not playback_current_generation(keys) then return nil end
  return keys
end

local function playback_prune_global_index(now, key, limit)
  local boundedLimit = tonumber(limit) or 32
  local expired = redis.call("ZRANGEBYSCORE", key, "-inf", now, "LIMIT", 0, boundedLimit)
  if #expired > 0 then redis.call("ZREM", key, unpack(expired)) end
end

local function playback_prune_globals(now, contextKey, claimKey, tombstoneKey, limit)
  playback_prune_global_index(now, contextKey, limit)
  playback_prune_global_index(now, claimKey, limit)
  playback_prune_global_index(now, tombstoneKey, limit)
end

local function playback_has_due_globals(now, contextKey, claimKey, tombstoneKey)
  return redis.call("ZCOUNT", contextKey, "-inf", now) > 0 or
    redis.call("ZCOUNT", claimKey, "-inf", now) > 0 or
    redis.call("ZCOUNT", tombstoneKey, "-inf", now) > 0
end

local function playback_min_score(key)
  local item = redis.call("ZRANGE", key, 0, 0, "WITHSCORES")
  if #item == 0 then return nil end
  return tonumber(item[2])
end

local function playback_max_score(key)
  local item = redis.call("ZREVRANGE", key, 0, 0, "WITHSCORES")
  if #item == 0 then return nil end
  return tonumber(item[2])
end

local function playback_minimum(left, right)
  if right == nil then return left end
  if left == nil or right < left then return right end
  return left
end

local function playback_maximum(left, right)
  if right == nil then return left end
  if left == nil or right > left then return right end
  return left
end

local function playback_delete_profile(keys)
  redis.call(
    "DEL",
    keys.root,
    keys.contexts,
    keys.contextExpiries,
    keys.contextOrder,
    keys.equivalences,
    keys.claims,
    keys.claimExpiries,
    keys.claimOrder,
    keys.tombstones,
    keys.tombstoneGlobals,
    keys.tombstoneOrder
  )
  redis.call("ZREM", keys.schedule, keys.root)
end

local function playback_refresh_profile_ttl(keys, now, tombstoneTtlMs, cleanupPending)
  local nextExpiry = playback_minimum(
    playback_minimum(playback_min_score(keys.contextExpiries), playback_min_score(keys.claimExpiries)),
    playback_min_score(keys.tombstones)
  )
  local contextMax = playback_max_score(keys.contextExpiries)
  if contextMax then contextMax = contextMax + tombstoneTtlMs end
  local physicalExpiry = playback_maximum(
    playback_maximum(contextMax, playback_max_score(keys.claimExpiries)),
    playback_max_score(keys.tombstones)
  )
  if not nextExpiry or not physicalExpiry then
    playback_delete_profile(keys)
    return
  end
  if cleanupPending then
    -- Keep a due profile addressable until a later bounded pass consumes it.
    physicalExpiry = math.max(physicalExpiry, now + math.max(tombstoneTtlMs, 60000))
  elseif physicalExpiry <= now then
    playback_delete_profile(keys)
    return
  end
  for _, key in ipairs({
    keys.root,
    keys.contexts,
    keys.contextExpiries,
    keys.contextOrder,
    keys.equivalences,
    keys.claims,
    keys.claimExpiries,
    keys.claimOrder,
    keys.tombstones,
    keys.tombstoneGlobals,
    keys.tombstoneOrder
  }) do
    redis.call("PEXPIREAT", key, physicalExpiry)
  end
  redis.call("ZADD", keys.schedule, nextExpiry, keys.root)
end

local function playback_remove_context(keys, ref)
  local raw = redis.call("HGET", keys.contexts, ref)
  if not raw then
    redis.call("ZREM", keys.contextExpiries, ref)
    return nil, nil
  end
  local context = playback_decode_context_metadata(raw)
  if not context or context.ref ~= ref then return nil, "profile_collision" end
  redis.call("HDEL", keys.contexts, ref)
  redis.call("ZREM", keys.contextExpiries, ref)
  redis.call("ZREM", keys.globalContexts, context.globalMember)
  if context.equivalenceHash ~= "" and
     redis.call("HGET", keys.equivalences, context.equivalenceHash) == ref then
    redis.call("HDEL", keys.equivalences, context.equivalenceHash)
  end
  for _, indexKey in ipairs(context.fingerprintIndexKeys) do
    if redis.call("GET", indexKey) == ref then redis.call("DEL", indexKey) end
  end
  return context, nil
end

local function playback_remove_claim(keys, deviceRef)
  local raw = redis.call("HGET", keys.claims, deviceRef)
  if not raw then
    redis.call("ZREM", keys.claimExpiries, deviceRef)
    return nil, nil
  end
  local claim = playback_decode_claim(raw)
  if not claim or claim.deviceRef ~= deviceRef then return nil, "profile_collision" end
  redis.call("HDEL", keys.claims, deviceRef)
  redis.call("ZREM", keys.claimExpiries, deviceRef)
  redis.call("ZREM", keys.globalClaims, claim.globalMember)
  return claim, nil
end

local function playback_remove_tombstone(keys, hash)
  local globalMember = redis.call("HGET", keys.tombstoneGlobals, hash)
  redis.call("ZREM", keys.tombstones, hash)
  redis.call("HDEL", keys.tombstoneGlobals, hash)
  if globalMember then redis.call("ZREM", keys.globalTombstones, globalMember) end
end

local function playback_add_tombstone(keys, hash, globalMember, retainUntilMs, maxGlobal, maxProfile)
  local existing = redis.call("ZSCORE", keys.tombstones, hash)
  if existing and tonumber(existing) >= retainUntilMs then return end
  if not existing and (redis.call("ZCARD", keys.globalTombstones) >= maxGlobal or
     redis.call("ZCARD", keys.tombstones) >= maxProfile) then return end
  if existing then
    local previousGlobal = redis.call("HGET", keys.tombstoneGlobals, hash)
    if previousGlobal and previousGlobal ~= globalMember then
      redis.call("ZREM", keys.globalTombstones, previousGlobal)
    end
  end
  redis.call("ZADD", keys.tombstones, retainUntilMs, hash)
  redis.call("HSET", keys.tombstoneGlobals, hash, globalMember)
  redis.call("ZADD", keys.globalTombstones, retainUntilMs, globalMember)
end

local function playback_has_due_profile_entries(keys, now)
  return redis.call("ZCOUNT", keys.contextExpiries, "-inf", now) > 0 or
    redis.call("ZCOUNT", keys.claimExpiries, "-inf", now) > 0 or
    redis.call("ZCOUNT", keys.tombstones, "-inf", now) > 0
end

local function playback_purge_profile(
  keys,
  now,
  tombstoneTtlMs,
  maxTombstones,
  maxTombstonesPerProfile,
  entryBatchSize
)
  local remaining = tonumber(entryBatchSize)
  if not remaining or remaining < 1 or remaining > 256 or remaining ~= math.floor(remaining) then
    return "prune_invalid", false
  end

  local expiredContexts = redis.call(
    "ZRANGEBYSCORE", keys.contextExpiries, "-inf", now, "LIMIT", 0, remaining
  )
  for _, ref in ipairs(expiredContexts) do
    local context, contextError = playback_remove_context(keys, ref)
    if contextError then
      return contextError, playback_has_due_profile_entries(keys, now)
    end
    if context then
      local retainUntilMs = tonumber(context.expiresAtMs) + tombstoneTtlMs
      if retainUntilMs > now then
        for index, hash in ipairs(context.fingerprintHashes) do
          playback_add_tombstone(
            keys,
            hash,
            context.tombstoneMembers[index],
            retainUntilMs,
            maxTombstones,
            maxTombstonesPerProfile
          )
        end
      end
    end
  end
  remaining = remaining - #expiredContexts

  if remaining > 0 then
    local expiredClaims = redis.call(
      "ZRANGEBYSCORE", keys.claimExpiries, "-inf", now, "LIMIT", 0, remaining
    )
    for _, deviceRef in ipairs(expiredClaims) do
      local _, claimError = playback_remove_claim(keys, deviceRef)
      if claimError then return claimError, false end
    end
    remaining = remaining - #expiredClaims
  end

  if remaining > 0 then
    local expiredTombstones = redis.call(
      "ZRANGEBYSCORE", keys.tombstones, "-inf", now, "LIMIT", 0, remaining
    )
    for _, hash in ipairs(expiredTombstones) do playback_remove_tombstone(keys, hash) end
  end

  return nil, playback_has_due_profile_entries(keys, now)
end
