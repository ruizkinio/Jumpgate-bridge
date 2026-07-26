-- Subtitle source capabilities are versioned AEAD envelopes. Lua treats the
-- authenticated envelope as an opaque string and never decodes its plaintext.

local function subtitle_now_ms()
  local current = redis.call("TIME")
  return (tonumber(current[1]) * 1000) + math.floor(tonumber(current[2]) / 1000)
end

local function subtitle_key_type(key)
  local reply = redis.call("TYPE", key)
  if type(reply) == "table" then return reply.ok end
  return reply
end

local function subtitle_decode_json(raw)
  local ok, value = pcall(cjson.decode, raw)
  if not ok or type(value) ~= "table" then return nil end
  return value
end

local function subtitle_valid_decimal(value, maximumLength)
  if type(value) ~= "string" or #value < 1 or #value > maximumLength then return false end
  return value == "0" or string.match(value, "^[1-9][0-9]*$") ~= nil
end

local function subtitle_valid_generation(value)
  return type(value) == "string" and string.match(value, "^g1:[A-Za-z0-9_-]+$") ~= nil and #value <= 131
end

local function subtitle_decimal_compare(left, right)
  if not subtitle_valid_decimal(left, 128) or not subtitle_valid_decimal(right, 128) then return nil end
  if #left < #right then return -1 end
  if #left > #right then return 1 end
  if left < right then return -1 end
  if left > right then return 1 end
  return 0
end

local function subtitle_decimal_add(left, right)
  if not subtitle_valid_decimal(left, 128) or not subtitle_valid_decimal(right, 128) then return nil end
  local output = {}
  local leftIndex = #left
  local rightIndex = #right
  local carry = 0
  while leftIndex > 0 or rightIndex > 0 or carry > 0 do
    local leftDigit = leftIndex > 0 and string.byte(left, leftIndex) - 48 or 0
    local rightDigit = rightIndex > 0 and string.byte(right, rightIndex) - 48 or 0
    local value = leftDigit + rightDigit + carry
    output[#output + 1] = string.char(48 + (value % 10))
    carry = math.floor(value / 10)
    leftIndex = leftIndex - 1
    rightIndex = rightIndex - 1
  end
  local result = string.reverse(table.concat(output))
  if #result > 128 then return nil end
  return result
end

local function subtitle_decimal_subtract(left, right)
  local comparison = subtitle_decimal_compare(left, right)
  if comparison == nil or comparison < 0 then return nil end
  local output = {}
  local rightIndex = #right
  local borrow = 0
  for leftIndex = #left, 1, -1 do
    local leftDigit = string.byte(left, leftIndex) - 48 - borrow
    local rightDigit = rightIndex > 0 and string.byte(right, rightIndex) - 48 or 0
    if leftDigit < rightDigit then
      leftDigit = leftDigit + 10
      borrow = 1
    else
      borrow = 0
    end
    output[#output + 1] = string.char(48 + leftDigit - rightDigit)
    rightIndex = rightIndex - 1
  end
  local value = string.reverse(table.concat(output))
  value = string.gsub(value, "^0+", "")
  return value == "" and "0" or value
end

local function subtitle_counter(key, field)
  local value = redis.call("HGET", key, field) or "0"
  if not subtitle_valid_decimal(value, 128) then return nil end
  return value
end

local function subtitle_increment_counter(key, field, amount)
  local current = subtitle_counter(key, field)
  local updated = current and subtitle_decimal_add(current, amount) or nil
  if not updated then return nil end
  redis.call("HSET", key, field, updated)
  return updated
end

local function subtitle_decrement_counter(key, field, amount)
  local current = subtitle_counter(key, field)
  local updated = current and subtitle_decimal_subtract(current, amount) or nil
  if not updated then return nil end
  redis.call("HSET", key, field, updated)
  return updated
end

local function subtitle_would_exceed(key, field, amount, maximum)
  local current = subtitle_counter(key, field)
  local updated = current and subtitle_decimal_add(current, amount) or nil
  local comparison = updated and subtitle_decimal_compare(updated, maximum) or nil
  if comparison == nil then return nil end
  return comparison > 0
end

local function subtitle_minimum(...)
  local values = { ... }
  local result = nil
  for _, value in ipairs(values) do
    if value and (not result or value < result) then result = value end
  end
  return result
end

local function subtitle_global_keys(offset)
  return {
    root = KEYS[offset],
    artifacts = KEYS[offset + 1],
    deletions = KEYS[offset + 2],
    deletionClaims = KEYS[offset + 3],
    leaseExpiries = KEYS[offset + 4],
    leaseData = KEYS[offset + 5],
    uploadExpiries = KEYS[offset + 6],
    deletionTokens = KEYS[offset + 7],
    authorities = KEYS[offset + 8]
  }
end

local function subtitle_profile_keys(offset)
  return {
    root = KEYS[offset],
    artifacts = KEYS[offset + 1],
    discoveries = KEYS[offset + 2]
  }
end

local function subtitle_artifact_keys(offset)
  return {
    root = KEYS[offset],
    leaseData = KEYS[offset + 1],
    leaseExpiries = KEYS[offset + 2]
  }
end

local function subtitle_playback_keys(offset)
  return {
    root = KEYS[offset],
    contexts = KEYS[offset + 1],
    claims = KEYS[offset + 2],
    session = KEYS[offset + 3],
    generation = KEYS[offset + 4]
  }
end

local function subtitle_ensure_global(keys, create)
  local kind = subtitle_key_type(keys.root)
  if kind == "none" then
    if not create then return false, "not_found" end
    redis.call("HSET", keys.root,
      "schemaVersion", "2",
      "artifactsKey", keys.artifacts,
      "deletionsKey", keys.deletions,
      "deletionClaimsKey", keys.deletionClaims,
      "leaseExpiriesKey", keys.leaseExpiries,
      "leaseDataKey", keys.leaseData,
      "uploadExpiriesKey", keys.uploadExpiries,
      "deletionTokensKey", keys.deletionTokens,
      "authoritiesKey", keys.authorities,
      "artifacts", "0",
      "objects", "0",
      "bytes", "0",
      "leases", "0",
      "authorities", "0")
    return true, nil
  end
  if kind ~= "hash" or redis.call("HGET", keys.root, "schemaVersion") ~= "2" or
     redis.call("HGET", keys.root, "artifactsKey") ~= keys.artifacts or
     redis.call("HGET", keys.root, "deletionsKey") ~= keys.deletions or
     redis.call("HGET", keys.root, "deletionClaimsKey") ~= keys.deletionClaims or
     redis.call("HGET", keys.root, "leaseExpiriesKey") ~= keys.leaseExpiries or
     redis.call("HGET", keys.root, "leaseDataKey") ~= keys.leaseData or
     redis.call("HGET", keys.root, "uploadExpiriesKey") ~= keys.uploadExpiries or
     redis.call("HGET", keys.root, "deletionTokensKey") ~= keys.deletionTokens or
     redis.call("HGET", keys.root, "authoritiesKey") ~= keys.authorities then
    return false, "state_collision"
  end
  for _, field in ipairs({ "artifacts", "objects", "bytes", "leases", "authorities" }) do
    if not subtitle_counter(keys.root, field) then return false, "state_collision" end
  end
  return true, nil
end

local function subtitle_ensure_profile(keys, profileTag, create)
  local kind = subtitle_key_type(keys.root)
  if kind == "none" then
    if not create then return false, "not_found" end
    redis.call("HSET", keys.root,
      "schemaVersion", "2",
      "profileTag", profileTag,
      "artifactsKey", keys.artifacts,
      "discoveriesKey", keys.discoveries,
      "artifacts", "0",
      "objects", "0",
      "bytes", "0",
      "leases", "0")
    return true, nil
  end
  if kind ~= "hash" or redis.call("HGET", keys.root, "schemaVersion") ~= "2" or
     redis.call("HGET", keys.root, "profileTag") ~= profileTag or
     redis.call("HGET", keys.root, "artifactsKey") ~= keys.artifacts or
     redis.call("HGET", keys.root, "discoveriesKey") ~= keys.discoveries then
    return false, "state_collision"
  end
  for _, field in ipairs({ "artifacts", "objects", "bytes", "leases" }) do
    if not subtitle_counter(keys.root, field) then return false, "state_collision" end
  end
  return true, nil
end

local function subtitle_authority(globalKeys, profileTag)
  local raw = redis.call("HGET", globalKeys.authorities, profileTag)
  local value = raw and subtitle_decode_json(raw) or nil
  if not value or value.v ~= "1" or value.profileTag ~= profileTag or
     not subtitle_valid_decimal(value.providerRevision, 128) or
     not subtitle_valid_generation(value.generation) or
     not subtitle_valid_decimal(value.revision, 128) then
    return nil
  end
  return value
end

local function subtitle_authority_matches(globalKeys, profileTag, generation, providerRevision)
  local value = subtitle_authority(globalKeys, profileTag)
  return value and value.generation == generation and value.providerRevision == providerRevision
end

local function subtitle_active_claim(keys, expected, now)
  if subtitle_key_type(keys.root) ~= "hash" or
     redis.call("HGET", keys.root, "schemaVersion") ~= "3" or
     redis.call("HGET", keys.root, "profileTag") ~= expected.profileTag or
     redis.call("HGET", keys.root, "contextsKey") ~= keys.contexts or
     redis.call("HGET", keys.root, "claimsKey") ~= keys.claims or
     redis.call("HGET", keys.root, "generationKey") ~= keys.generation then
    return nil
  end
  local generation = playback_current_generation(keys)
  if generation ~= expected.generation or redis.call("GET", keys.session) ~= keys.root then return nil end

  local claimRaw = redis.call("HGET", keys.claims, expected.deviceRef)
  local claim = claimRaw and playback_decode_claim(claimRaw) or nil
  if not claim or claim.v ~= "4" or claim.deviceRef ~= expected.deviceRef or
     claim.released ~= "0" or claim.status ~= "claimed" or
     claim.sessionId ~= expected.sessionId or claim.sessionKey ~= keys.session or
     claim.contextRef ~= expected.contextRef or
     not subtitle_valid_decimal(claim.expiresAtMs, 16) then
    return nil
  end

  local contextRaw = redis.call("HGET", keys.contexts, expected.contextRef)
  local context = contextRaw and playback_decode_context_metadata(contextRaw) or nil
  if not context or context.v ~= "4" or context.ref ~= expected.contextRef or
     context.generation ~= expected.generation or context.revision ~= expected.contextRevision or
     context.providerRevision ~= expected.providerRevision or
     not subtitle_valid_decimal(context.expiresAtMs, 16) then
    return nil
  end

  local claimExpiry = tonumber(claim.expiresAtMs)
  local contextExpiry = tonumber(context.expiresAtMs)
  if not claimExpiry or not contextExpiry or claimExpiry <= now or contextExpiry <= now then return nil end
  return {
    claimExpiresAtMs = claimExpiry,
    contextExpiresAtMs = contextExpiry,
    expiresAtMs = math.min(claimExpiry, contextExpiry)
  }
end

local function subtitle_artifact_binding_matches(key, expected)
  local schemaVersion = redis.call("HGET", key, "schemaVersion")
  if subtitle_key_type(key) ~= "hash" or
     (schemaVersion ~= "2" and schemaVersion ~= "3") then
    return false
  end
  return redis.call("HGET", key, "profileTag") == expected.profileTag and
    redis.call("HGET", key, "deviceRef") == expected.deviceRef and
    redis.call("HGET", key, "sessionRef") == expected.sessionRef and
    redis.call("HGET", key, "generation") == expected.generation and
    redis.call("HGET", key, "contextRef") == expected.contextRef and
    redis.call("HGET", key, "contextRevision") == expected.contextRevision and
    redis.call("HGET", key, "providerRevision") == expected.providerRevision
end

local function subtitle_artifact_matches(key, expected)
  return subtitle_artifact_binding_matches(key, expected) and
    redis.call("HGET", key, "artifactId") == expected.artifactId and
    redis.call("HGET", key, "artifactRef") == expected.artifactRef
end

local function subtitle_valid_digest(value)
  return type(value) == "string" and #value == 64 and
    string.match(value, "^[a-f0-9]+$") ~= nil
end

local function subtitle_artifact_schema(key)
  if subtitle_key_type(key) ~= "hash" then return nil end
  local schemaVersion = redis.call("HGET", key, "schemaVersion")
  if schemaVersion ~= "2" and schemaVersion ~= "3" then return nil end
  return schemaVersion
end

local function subtitle_valid_part_tuple(count, index, role, extension, mediaType)
  if count == 1 then
    if role ~= "subtitle" then return false end
    local textTypes = {
      [".srt"] = "application/x-subrip",
      [".vtt"] = "text/vtt",
      [".ass"] = "text/x-ssa",
      [".ssa"] = "text/x-ssa",
      [".smi"] = "application/x-sami",
      [".sub"] = "text/x-microdvd",
      [".txt"] = "text/plain"
    }
    return textTypes[extension] == mediaType
  end
  if count ~= 2 then return false end
  if index == 1 then
    return role == "index" and extension == ".idx" and mediaType == "application/x-vobsub"
  end
  return role == "sub" and extension == ".sub" and mediaType == "application/octet-stream"
end

local function subtitle_v3_parts(key)
  if redis.call("HGET", key, "partMetadataVersion") ~= "1" then return nil end
  local countRaw = redis.call("HGET", key, "partCount")
  if not subtitle_valid_decimal(countRaw, 2) then return nil end
  local count = tonumber(countRaw)
  if not count or count < 1 or count > 2 then return nil end
  local total = "0"
  local parts = {}
  for index = 1, count do
    local suffix = tostring(index)
    local part = {
      objectKey = redis.call("HGET", key, "objectKey" .. suffix),
      partNumber = redis.call("HGET", key, "partNumber" .. suffix),
      size = redis.call("HGET", key, "partSize" .. suffix),
      checksum = redis.call("HGET", key, "partChecksum" .. suffix),
      role = redis.call("HGET", key, "partRole" .. suffix),
      extension = redis.call("HGET", key, "partExtension" .. suffix),
      mediaType = redis.call("HGET", key, "partMediaType" .. suffix)
    }
    if type(part.objectKey) ~= "string" or part.objectKey == "" or
       part.partNumber ~= suffix or
       not subtitle_valid_decimal(part.size, 128) or part.size == "0" or
       not subtitle_valid_digest(part.checksum) or
       not subtitle_valid_part_tuple(count, index, part.role, part.extension, part.mediaType) then
      return nil
    end
    total = subtitle_decimal_add(total, part.size)
    if not total then return nil end
    parts[index] = part
  end
  if count == 1 then
    for _, field in ipairs({
      "objectKey2", "partNumber2", "partSize2", "partChecksum2",
      "partRole2", "partExtension2", "partMediaType2"
    }) do
      if redis.call("HEXISTS", key, field) ~= 0 then return nil end
    end
  end
  return { count = count, countRaw = countRaw, total = total, parts = parts }
end

-- Authority publication relies on this entire block remaining read-only.
local function subtitle_authority_store_preflight(globalKeys)
  local rootType = subtitle_key_type(globalKeys.root)
  local indexTypes = {
    { globalKeys.artifacts, "zset" },
    { globalKeys.deletions, "zset" },
    { globalKeys.deletionClaims, "zset" },
    { globalKeys.leaseExpiries, "zset" },
    { globalKeys.leaseData, "hash" },
    { globalKeys.uploadExpiries, "zset" },
    { globalKeys.deletionTokens, "hash" },
    { globalKeys.authorities, "hash" }
  }
  if rootType == "none" then
    for _, entry in ipairs(indexTypes) do
      if subtitle_key_type(entry[1]) ~= "none" then return nil end
    end
    return "missing"
  end
  local globalOk = subtitle_ensure_global(globalKeys, false)
  if not globalOk then return nil end
  for _, entry in ipairs(indexTypes) do
    local kind = subtitle_key_type(entry[1])
    if kind ~= "none" and kind ~= entry[2] then return nil end
  end
  return "present"
end

local function subtitle_authority_binding_matches(key, authority)
  return authority and redis.call("HGET", key, "generation") == authority.generation and
    redis.call("HGET", key, "providerRevision") == authority.providerRevision
end

local function subtitle_authority_artifact_preflight(
  globalKeys, profileKeys, key, profileTag, currentAuthority, nextAuthority
)
  local schemaVersion = subtitle_artifact_schema(key)
  if type(key) ~= "string" or key == "" or not schemaVersion or
     redis.call("HGET", key, "profileTag") ~= profileTag or
     redis.call("HGET", key, "profileRootKey") ~= profileKeys.root or
     redis.call("HGET", key, "profileArtifactsKey") ~= profileKeys.artifacts or
     redis.call("HGET", key, "profileDiscoveriesKey") ~= profileKeys.discoveries then
    return nil
  end

  local artifactId = redis.call("HGET", key, "artifactId")
  local artifactRef = redis.call("HGET", key, "artifactRef")
  local discoveryRef = redis.call("HGET", key, "discoveryRef")
  if type(artifactId) ~= "string" or #artifactId < 1 or #artifactId > 256 or
     not subtitle_valid_digest(artifactRef) or not subtitle_valid_digest(discoveryRef) or
     redis.call("HGET", profileKeys.discoveries, discoveryRef) ~= key then
    return nil
  end

  if not subtitle_authority_binding_matches(key, currentAuthority) and
     not subtitle_authority_binding_matches(key, nextAuthority) then
    return nil
  end

  local expiresAtRaw = redis.call("HGET", key, "expiresAtMs")
  local absoluteExpiresAtRaw = redis.call("HGET", key, "absoluteExpiresAtMs")
  local profileScore = redis.call("ZSCORE", profileKeys.artifacts, key)
  local globalScore = redis.call("ZSCORE", globalKeys.artifacts, key)
  if not subtitle_valid_decimal(expiresAtRaw, 16) or
     not subtitle_valid_decimal(absoluteExpiresAtRaw, 16) or
     not profileScore or not globalScore or
     tonumber(profileScore) ~= tonumber(expiresAtRaw) or
     tonumber(globalScore) ~= tonumber(expiresAtRaw) or
     tonumber(absoluteExpiresAtRaw) < tonumber(expiresAtRaw) then
    return nil
  end

  local state = redis.call("HGET", key, "state")
  local uploadState = redis.call("HGET", key, "uploadState")
  local partCountRaw = redis.call("HGET", key, "partCount")
  local partCount = tonumber(partCountRaw)
  if redis.call("HGET", key, "deletionRequested") ~= "0" or
     redis.call("HGET", key, "deletionPhase") ~= "none" or
     not partCount or partCount < 0 or partCount > 2 or tostring(partCount) ~= partCountRaw then
    return nil
  end
  if redis.call("ZSCORE", globalKeys.deletions, key) or
     redis.call("ZSCORE", globalKeys.deletionClaims, key) or
     redis.call("HEXISTS", key, "deletionTokenHash") ~= 0 or
     redis.call("HEXISTS", key, "deletionDueAtMs") ~= 0 then
    return nil
  end

  local reservedObjects = redis.call("HGET", key, "reservedObjects")
  local reservedBytes = redis.call("HGET", key, "reservedBytes")
  local quotaObjects = redis.call("HGET", key, "quotaObjects")
  local quotaBytes = redis.call("HGET", key, "quotaBytes")
  if not subtitle_valid_decimal(reservedObjects, 4) or reservedObjects == "0" or
     not subtitle_valid_decimal(reservedBytes, 128) or reservedBytes == "0" or
     not subtitle_valid_decimal(quotaObjects, 4) or quotaObjects == "0" or
     not subtitle_valid_decimal(quotaBytes, 128) or quotaBytes == "0" or
     subtitle_decimal_compare(reservedObjects, quotaObjects) < 0 or
     subtitle_decimal_compare(reservedBytes, quotaBytes) < 0 then
    return nil
  end

  local uploadScore = redis.call("ZSCORE", globalKeys.uploadExpiries, key)
  if state == "reserved" then
    local envelope = redis.call("HGET", key, "sourceEnvelope")
    if uploadState ~= "none" or partCount ~= 0 or quotaObjects ~= reservedObjects or
       quotaBytes ~= reservedBytes or not subtitle_valid_digest(
         redis.call("HGET", key, "reservationTokenHash")
       ) or type(envelope) ~= "string" or #envelope < 2 or #envelope > 1048576 or
       redis.call("HEXISTS", key, "objectKey1") ~= 0 or
       redis.call("HEXISTS", key, "objectKey2") ~= 0 or
       redis.call("HEXISTS", key, "partMetadataVersion") ~= 0 or
       redis.call("HEXISTS", key, "fetchTokenHash") ~= 0 or
       redis.call("HEXISTS", key, "fetchExpiresAtMs") ~= 0 or uploadScore then
      return nil
    end
    if schemaVersion == "3" and
       not subtitle_valid_decimal(redis.call("HGET", key, "fetchFence"), 128) then
      return nil
    end
  elseif state == "fetching" then
    if schemaVersion ~= "3" then return nil end
    local envelope = redis.call("HGET", key, "sourceEnvelope")
    local fetchExpiresAtRaw = redis.call("HGET", key, "fetchExpiresAtMs")
    if uploadState ~= "none" or partCount ~= 0 or quotaObjects ~= reservedObjects or
       quotaBytes ~= reservedBytes or not subtitle_valid_digest(
         redis.call("HGET", key, "reservationTokenHash")
       ) or not subtitle_valid_digest(redis.call("HGET", key, "fetchTokenHash")) or
       not subtitle_valid_decimal(redis.call("HGET", key, "fetchFence"), 128) or
       redis.call("HGET", key, "fetchFence") == "0" or
       type(envelope) ~= "string" or #envelope < 2 or #envelope > 1048576 or
       not subtitle_valid_decimal(fetchExpiresAtRaw, 16) or not uploadScore or
       tonumber(uploadScore) ~= tonumber(fetchExpiresAtRaw) or
       redis.call("HEXISTS", key, "partMetadataVersion") ~= 0 or
       redis.call("HEXISTS", key, "objectKey1") ~= 0 or
       redis.call("HEXISTS", key, "objectKey2") ~= 0 then
      return nil
    end
  elseif state == "uploading" then
    local envelope = redis.call("HGET", key, "sourceEnvelope")
    local uploadExpiresAtRaw = redis.call("HGET", key, "uploadExpiresAtMs")
    local settlesAtRaw = redis.call("HGET", key, "uploadSettlesAtMs")
    local startedAtRaw = redis.call("HGET", key, "uploadStartedAtMs")
    local lastStartedAtRaw = redis.call("HGET", key, "uploadLastStartedAtMs")
    local maximumPutLifetimeRaw = redis.call("HGET", key, "uploadMaximumPutLifetimeMs")
    local settlementGraceRaw = redis.call("HGET", key, "uploadSettlementGraceMs")
    if uploadState ~= "active" or partCount < 1 or not subtitle_valid_digest(
         redis.call("HGET", key, "uploadTokenHash")
       ) or not subtitle_valid_digest(redis.call("HGET", key, "uploadAttemptRef")) or
       type(envelope) ~= "string" or #envelope < 2 or #envelope > 1048576 or
       not subtitle_valid_decimal(uploadExpiresAtRaw, 16) or
       not subtitle_valid_decimal(settlesAtRaw, 16) or
       not subtitle_valid_decimal(startedAtRaw, 16) or
       not subtitle_valid_decimal(lastStartedAtRaw, 16) or
       not subtitle_valid_decimal(maximumPutLifetimeRaw, 16) or
       not subtitle_valid_decimal(settlementGraceRaw, 16) or
       tonumber(maximumPutLifetimeRaw) < 1 or tonumber(maximumPutLifetimeRaw) > 120000 or
       tonumber(settlementGraceRaw) < 1 or tonumber(settlementGraceRaw) > 120000 or
       tonumber(startedAtRaw) > tonumber(lastStartedAtRaw) or
       tonumber(lastStartedAtRaw) > tonumber(uploadExpiresAtRaw) or not uploadScore or
       tonumber(uploadScore) ~= tonumber(uploadExpiresAtRaw) or
       tonumber(settlesAtRaw) < tonumber(uploadExpiresAtRaw) +
          tonumber(maximumPutLifetimeRaw) + tonumber(settlementGraceRaw) then
      return nil
    end
    if schemaVersion == "2" then
      if quotaObjects ~= reservedObjects or quotaBytes ~= reservedBytes or
         redis.call("HEXISTS", key, "partMetadataVersion") ~= 0 then return nil end
      for index = 1, partCount do
        local objectKey = redis.call("HGET", key, "objectKey" .. tostring(index))
        if type(objectKey) ~= "string" or objectKey == "" then return nil end
      end
      if partCount == 1 and redis.call("HEXISTS", key, "objectKey2") ~= 0 then return nil end
    else
      local staged = subtitle_v3_parts(key)
      if not staged or staged.count ~= partCount or quotaObjects ~= staged.countRaw or
         quotaBytes ~= staged.total or redis.call("HGET", key, "actualBytes") ~= staged.total or
         not subtitle_valid_digest(redis.call("HGET", key, "fetchTokenHash")) or
         not subtitle_valid_decimal(redis.call("HGET", key, "fetchFence"), 128) or
         redis.call("HEXISTS", key, "fetchExpiresAtMs") ~= 0 then return nil end
    end
  elseif state == "committed" then
    local settlesAtRaw = redis.call("HGET", key, "uploadSettlesAtMs")
    local actualBytes = redis.call("HGET", key, "actualBytes")
    local startedAtRaw = redis.call("HGET", key, "uploadStartedAtMs")
    local lastStartedAtRaw = redis.call("HGET", key, "uploadLastStartedAtMs")
    local terminalAtRaw = redis.call("HGET", key, "uploadTerminalAtMs")
    local committedAtRaw = redis.call("HGET", key, "committedAtMs")
    local maximumPutLifetimeRaw = redis.call("HGET", key, "uploadMaximumPutLifetimeMs")
    local settlementGraceRaw = redis.call("HGET", key, "uploadSettlementGraceMs")
    if uploadState ~= "complete" or partCount < 1 or
       not subtitle_valid_decimal(settlesAtRaw, 16) or
       not subtitle_valid_decimal(startedAtRaw, 16) or
       not subtitle_valid_decimal(lastStartedAtRaw, 16) or
       not subtitle_valid_decimal(terminalAtRaw, 16) or
       not subtitle_valid_decimal(committedAtRaw, 16) or
       not subtitle_valid_decimal(maximumPutLifetimeRaw, 16) or
       not subtitle_valid_decimal(settlementGraceRaw, 16) or
       tonumber(maximumPutLifetimeRaw) < 1 or tonumber(maximumPutLifetimeRaw) > 120000 or
       tonumber(settlementGraceRaw) < 1 or tonumber(settlementGraceRaw) > 120000 or
       tonumber(startedAtRaw) > tonumber(lastStartedAtRaw) or
       tonumber(lastStartedAtRaw) > tonumber(terminalAtRaw) or
       tonumber(terminalAtRaw) ~= tonumber(committedAtRaw) or
       tonumber(settlesAtRaw) < tonumber(terminalAtRaw) or
       not subtitle_valid_decimal(actualBytes, 128) or actualBytes == "0" or
       quotaBytes ~= actualBytes or redis.call("HEXISTS", key, "sourceEnvelope") ~= 0 or
       uploadScore then
      return nil
    end
    if schemaVersion == "2" then
      if quotaObjects ~= tostring(partCount) or
         redis.call("HEXISTS", key, "partMetadataVersion") ~= 0 then return nil end
      local total = "0"
      for index = 1, partCount do
        local objectKey = redis.call("HGET", key, "objectKey" .. tostring(index))
        local partSize = redis.call("HGET", key, "partSize" .. tostring(index))
        local checksum = redis.call("HGET", key, "partChecksum" .. tostring(index))
        if type(objectKey) ~= "string" or objectKey == "" or
           not subtitle_valid_decimal(partSize, 128) or partSize == "0" or
           not subtitle_valid_digest(checksum) then return nil end
        total = subtitle_decimal_add(total, partSize)
        if not total then return nil end
      end
      if total ~= actualBytes or
         (partCount == 1 and redis.call("HEXISTS", key, "objectKey2") ~= 0) then return nil end
    else
      local staged = subtitle_v3_parts(key)
      if not staged or staged.count ~= partCount or quotaObjects ~= staged.countRaw or
         quotaBytes ~= staged.total or staged.total ~= actualBytes or
         not subtitle_valid_digest(redis.call("HGET", key, "fetchTokenHash")) or
         not subtitle_valid_decimal(redis.call("HGET", key, "fetchFence"), 128) then return nil end
    end
  else
    return nil
  end

  return {
    key = key,
    schemaVersion = schemaVersion,
    state = state,
    expiresAtMs = expiresAtRaw,
    discoveryRef = discoveryRef,
    workExpiresAtMs = state == "fetching" and redis.call("HGET", key, "fetchExpiresAtMs") or nil
  }, quotaObjects, quotaBytes
end

local function subtitle_authority_artifacts_preflight(
  globalKeys, profileKeys, profileTag, currentAuthority, nextAuthority, maximum, globalState
)
  local profileRootType = subtitle_key_type(profileKeys.root)
  local profileArtifactsType = subtitle_key_type(profileKeys.artifacts)
  local profileDiscoveriesType = subtitle_key_type(profileKeys.discoveries)
  if profileRootType == "none" then
    if profileArtifactsType ~= "none" or profileDiscoveriesType ~= "none" then return nil end
    return {}
  end
  if globalState ~= "present" then return nil end
  local profileOk = subtitle_ensure_profile(profileKeys, profileTag, false)
  if not profileOk or
     (profileArtifactsType ~= "none" and profileArtifactsType ~= "zset") or
     (profileDiscoveriesType ~= "none" and profileDiscoveriesType ~= "hash") then
    return nil
  end

  local count = redis.call("ZCARD", profileKeys.artifacts)
  if count > maximum or redis.call("HLEN", profileKeys.discoveries) ~= count then return nil end
  local artifacts = redis.call("ZRANGE", profileKeys.artifacts, 0, maximum - 1)
  if #artifacts ~= count then return nil end

  local totalObjects = "0"
  local totalBytes = "0"
  local prepared = {}
  for _, artifactKey in ipairs(artifacts) do
    local artifact, quotaObjects, quotaBytes = subtitle_authority_artifact_preflight(
      globalKeys, profileKeys, artifactKey, profileTag, currentAuthority, nextAuthority
    )
    if not artifact then return nil end
    prepared[#prepared + 1] = artifact
    totalObjects = subtitle_decimal_add(totalObjects, quotaObjects)
    totalBytes = subtitle_decimal_add(totalBytes, quotaBytes)
    if not totalObjects or not totalBytes then return nil end
  end

  for _, check in ipairs({
    { profileKeys.root, "artifacts", tostring(count) },
    { profileKeys.root, "objects", totalObjects },
    { profileKeys.root, "bytes", totalBytes },
    { globalKeys.root, "artifacts", tostring(count) },
    { globalKeys.root, "objects", totalObjects },
    { globalKeys.root, "bytes", totalBytes }
  }) do
    local current = subtitle_counter(check[1], check[2])
    if not current or subtitle_decimal_compare(current, check[3]) < 0 then return nil end
  end
  return prepared
end

local function subtitle_restore_authority_artifact(globalKeys, profileKeys, artifact)
  redis.call("ZREM", globalKeys.deletions, artifact.key)
  redis.call("ZADD", globalKeys.artifacts, artifact.expiresAtMs, artifact.key)
  redis.call("ZADD", profileKeys.artifacts, artifact.expiresAtMs, artifact.key)
  redis.call("HSET", profileKeys.discoveries, artifact.discoveryRef, artifact.key)
  redis.call("HSET", artifact.key,
    "state", artifact.state,
    "deletionRequested", "0",
    "deletionPhase", "none",
    "expiresAtMs", artifact.expiresAtMs)
  redis.call("HDEL", artifact.key, "deletionDueAtMs")
  if artifact.state == "fetching" and artifact.workExpiresAtMs then
    redis.call("ZADD", globalKeys.uploadExpiries, artifact.workExpiresAtMs, artifact.key)
  end
end

local function subtitle_remove_active_indexes(globalKeys, key)
  local profileArtifacts = redis.call("HGET", key, "profileArtifactsKey")
  if profileArtifacts then redis.call("ZREM", profileArtifacts, key) end
  redis.call("ZREM", globalKeys.artifacts, key)
  local discoveries = redis.call("HGET", key, "profileDiscoveriesKey")
  local discoveryRef = redis.call("HGET", key, "discoveryRef")
  if discoveries and discoveryRef and redis.call("HGET", discoveries, discoveryRef) == key then
    redis.call("HDEL", discoveries, discoveryRef)
  end
end

local function subtitle_refresh_expiry(key, now, active, slidingTtlMs, globalArtifacts)
  local absoluteExpiry = tonumber(redis.call("HGET", key, "absoluteExpiresAtMs"))
  if not absoluteExpiry or absoluteExpiry <= now then return nil end
  local expiresAt = subtitle_minimum(
    absoluteExpiry,
    active.claimExpiresAtMs,
    active.contextExpiresAtMs,
    now + slidingTtlMs
  )
  if not expiresAt or expiresAt <= now then return nil end
  local profileArtifacts = redis.call("HGET", key, "profileArtifactsKey")
  if not profileArtifacts then return nil end
  redis.call("HSET", key, "expiresAtMs", tostring(expiresAt))
  redis.call("ZADD", globalArtifacts, expiresAt, key)
  redis.call("ZADD", profileArtifacts, expiresAt, key)
  return expiresAt
end

local function subtitle_schedule_first_deletion(globalKeys, key, dueAt, phase)
  redis.call("HSET", key,
    "state", "deleting",
    "deletionPhase", phase or "first_pending",
    "deletionDueAtMs", tostring(dueAt))
  redis.call("ZADD", globalKeys.deletions, dueAt, key)
end

local function subtitle_mark_deleting(globalKeys, key, now, retainSourceEnvelope)
  local schemaVersion = subtitle_artifact_schema(key)
  if not schemaVersion then return false end
  local state = redis.call("HGET", key, "state")
  if state == "deleting" or state == "deletion_claimed" or redis.call("HGET", key, "deletionRequested") == "1" then
    return false
  end
  if state ~= "reserved" and state ~= "fetching" and
     state ~= "uploading" and state ~= "committed" then return false end
  if state == "fetching" and
     (schemaVersion ~= "3" or not subtitle_valid_digest(
       redis.call("HGET", key, "fetchTokenHash")
     )) then return false end
  local firstDeleteAt = now
  if state == "committed" and redis.call("HGET", key, "uploadState") == "complete" then
    local settlesAtRaw = redis.call("HGET", key, "uploadSettlesAtMs")
    if not subtitle_valid_decimal(settlesAtRaw, 16) then return false end
    local settlesAt = tonumber(settlesAtRaw)
    if not settlesAt then return false end
    firstDeleteAt = math.max(firstDeleteAt, settlesAt)
  end
  subtitle_remove_active_indexes(globalKeys, key)
  if not retainSourceEnvelope then redis.call("HDEL", key, "sourceEnvelope") end
  redis.call("HSET", key,
    "deletionRequested", "1",
    "expiresAtMs", tostring(now))
  if state == "fetching" then
    local fetchTokenHash = redis.call("HGET", key, "fetchTokenHash")
    redis.call("ZREM", globalKeys.uploadExpiries, key)
    if not retainSourceEnvelope then
      redis.call("HSET", key, "fetchFencedTokenHash", fetchTokenHash)
      redis.call("HDEL", key, "fetchTokenHash", "fetchExpiresAtMs")
    end
    subtitle_schedule_first_deletion(globalKeys, key, now, "empty_pending")
    return true
  end
  if state == "reserved" then
    subtitle_schedule_first_deletion(globalKeys, key, now, "empty_pending")
    return true
  end
  if state == "uploading" and redis.call("HGET", key, "uploadState") == "active" then
    redis.call("HSET", key, "deletionPhase", "waiting_upload")
    return true
  end
  subtitle_schedule_first_deletion(globalKeys, key, firstDeleteAt)
  return true
end

local function subtitle_terminal_abort_upload(globalKeys, key, now)
  if not subtitle_artifact_schema(key) or
     redis.call("HGET", key, "state") ~= "uploading" or
     redis.call("HGET", key, "uploadState") ~= "active" then
    return false
  end
  local settlesAtRaw = redis.call("HGET", key, "uploadSettlesAtMs")
  if not subtitle_valid_decimal(settlesAtRaw, 16) then return false end
  local settlesAt = tonumber(settlesAtRaw)
  if not settlesAt then return false end
  local firstDeleteAt = math.max(now, settlesAt)
  subtitle_remove_active_indexes(globalKeys, key)
  redis.call("ZREM", globalKeys.uploadExpiries, key)
  redis.call("HSET", key,
    "state", "deleting",
    "deletionRequested", "1",
    "deletionPhase", "first_pending",
    "uploadState", "aborted",
    "uploadTerminalAtMs", tostring(now),
    "expiresAtMs", tostring(now),
    "deletionDueAtMs", tostring(firstDeleteAt))
  redis.call("HDEL", key, "sourceEnvelope", "uploadExpiresAtMs")
  redis.call("ZADD", globalKeys.deletions, firstDeleteAt, key)
  return true
end

local function subtitle_reset_expired_fetch(globalKeys, key, now)
  if subtitle_artifact_schema(key) ~= "3" or
     redis.call("HGET", key, "state") ~= "fetching" or
     redis.call("HGET", key, "uploadState") ~= "none" or
     redis.call("HGET", key, "deletionRequested") ~= "0" then return false end
  local tokenHash = redis.call("HGET", key, "fetchTokenHash")
  local expiresAtRaw = redis.call("HGET", key, "fetchExpiresAtMs")
  local score = redis.call("ZSCORE", globalKeys.uploadExpiries, key)
  if not subtitle_valid_digest(tokenHash) or not subtitle_valid_decimal(expiresAtRaw, 16) or
     not score or tonumber(score) ~= tonumber(expiresAtRaw) or tonumber(expiresAtRaw) > now then
    return false
  end
  redis.call("ZREM", globalKeys.uploadExpiries, key)
  redis.call("HSET", key,
    "state", "reserved",
    "fetchFencedTokenHash", tokenHash)
  redis.call("HDEL", key, "fetchTokenHash", "fetchExpiresAtMs")
  return true
end

local function subtitle_append_parts(reply, key)
  local schemaVersion = subtitle_artifact_schema(key)
  if not schemaVersion then return false end
  local countRaw = redis.call("HGET", key, "partCount") or "0"
  if not subtitle_valid_decimal(countRaw, 2) then return false end
  local count = tonumber(countRaw)
  if not count or count < 0 or count > 2 then return false end
  local metadataVersion = redis.call("HGET", key, "partMetadataVersion") or ""
  if schemaVersion == "2" and metadataVersion ~= "" then return false end
  local staged = nil
  if schemaVersion == "3" and count > 0 then
    staged = subtitle_v3_parts(key)
    if not staged then return false end
    metadataVersion = "1"
  elseif schemaVersion == "3" and metadataVersion ~= "" then
    return false
  end
  reply[#reply + 1] = schemaVersion
  reply[#reply + 1] = metadataVersion
  reply[#reply + 1] = tostring(count)
  for index = 1, count do
    local objectKey = redis.call("HGET", key, "objectKey" .. tostring(index))
    if not objectKey then return false end
    reply[#reply + 1] = objectKey
    reply[#reply + 1] = schemaVersion == "3" and
      redis.call("HGET", key, "partNumber" .. tostring(index)) or ""
    reply[#reply + 1] = redis.call("HGET", key, "partSize" .. tostring(index)) or ""
    reply[#reply + 1] = redis.call("HGET", key, "partChecksum" .. tostring(index)) or ""
    reply[#reply + 1] = schemaVersion == "3" and
      redis.call("HGET", key, "partRole" .. tostring(index)) or ""
    reply[#reply + 1] = schemaVersion == "3" and
      redis.call("HGET", key, "partExtension" .. tostring(index)) or ""
    reply[#reply + 1] = schemaVersion == "3" and
      redis.call("HGET", key, "partMediaType" .. tostring(index)) or ""
  end
  return true
end

local function subtitle_append_upload_parts(reply, key)
  if subtitle_artifact_schema(key) ~= "2" then return false end
  local countRaw = redis.call("HGET", key, "partCount")
  if not subtitle_valid_decimal(countRaw, 2) then return false end
  local count = tonumber(countRaw)
  if not count or count < 1 or count > 2 then return false end
  reply[#reply + 1] = tostring(count)
  for index = 1, count do
    local objectKey = redis.call("HGET", key, "objectKey" .. tostring(index))
    if not objectKey then return false end
    reply[#reply + 1] = objectKey
  end
  return true
end

local function subtitle_valid_lease_directory(directory, member)
  return directory and directory.v == "2" and directory.member == member and
    type(directory.tokenHash) == "string" and
    type(directory.artifactKey) == "string" and
    type(directory.artifactLeaseDataKey) == "string" and
    type(directory.artifactLeaseExpiriesKey) == "string" and
    type(directory.profileRootKey) == "string" and
    subtitle_valid_decimal(directory.expiresAtMs, 16)
end

local function subtitle_release_directory(globalKeys, raw, directory)
  if not subtitle_valid_lease_directory(directory, directory and directory.member or "") then return false end
  if redis.call("HGET", globalKeys.leaseData, directory.member) ~= raw then return false end
  local artifactRaw = redis.call("HGET", directory.artifactLeaseDataKey, directory.tokenHash)
  local artifactDirectory = artifactRaw and subtitle_decode_json(artifactRaw) or nil
  if not artifactDirectory or artifactDirectory.member ~= directory.member then return false end

  local globalLeases = subtitle_counter(globalKeys.root, "leases")
  local profileLeases = subtitle_counter(directory.profileRootKey, "leases")
  if not globalLeases or not profileLeases or
     subtitle_decimal_compare(globalLeases, "1") < 0 or
     subtitle_decimal_compare(profileLeases, "1") < 0 then
    return false
  end
  redis.call("HDEL", globalKeys.leaseData, directory.member)
  redis.call("ZREM", globalKeys.leaseExpiries, directory.member)
  redis.call("HDEL", directory.artifactLeaseDataKey, directory.tokenHash)
  redis.call("ZREM", directory.artifactLeaseExpiriesKey, directory.tokenHash)
  subtitle_decrement_counter(globalKeys.root, "leases", "1")
  subtitle_decrement_counter(directory.profileRootKey, "leases", "1")
  return true
end

local function subtitle_cleanup_global_leases(globalKeys, now, maximum)
  local due = redis.call("ZRANGEBYSCORE", globalKeys.leaseExpiries, "-inf", now, "LIMIT", 0, maximum)
  local removed = 0
  for _, member in ipairs(due) do
    local raw = redis.call("HGET", globalKeys.leaseData, member)
    local directory = raw and subtitle_decode_json(raw) or nil
    if subtitle_valid_lease_directory(directory, member) and tonumber(directory.expiresAtMs) <= now then
      if subtitle_release_directory(globalKeys, raw, directory) then removed = removed + 1 end
    else
      redis.call("ZREM", globalKeys.leaseExpiries, member)
      if raw then redis.call("HDEL", globalKeys.leaseData, member) end
    end
  end
  return removed
end

local function subtitle_cleanup_artifact_leases(globalKeys, artifactKeys, now, maximum)
  local due = redis.call("ZRANGEBYSCORE", artifactKeys.leaseExpiries, "-inf", now, "LIMIT", 0, maximum)
  local removed = 0
  for _, tokenHash in ipairs(due) do
    local raw = redis.call("HGET", artifactKeys.leaseData, tokenHash)
    local directory = raw and subtitle_decode_json(raw) or nil
    if subtitle_valid_lease_directory(directory, directory and directory.member or "") and
       directory.artifactKey == artifactKeys.root and tonumber(directory.expiresAtMs) <= now then
      local globalRaw = redis.call("HGET", globalKeys.leaseData, directory.member)
      if globalRaw and subtitle_release_directory(globalKeys, globalRaw, directory) then removed = removed + 1 end
    else
      redis.call("ZREM", artifactKeys.leaseExpiries, tokenHash)
      if raw then redis.call("HDEL", artifactKeys.leaseData, tokenHash) end
    end
  end
  return removed
end

local function subtitle_requeue_expired_deletion_claim(globalKeys, key, now)
  if not subtitle_artifact_schema(key) or
     redis.call("HGET", key, "state") ~= "deletion_claimed" then
    redis.call("ZREM", globalKeys.deletionClaims, key)
    return false
  end
  local expiresAt = tonumber(redis.call("HGET", key, "deletionLeaseExpiresAtMs"))
  if not expiresAt or expiresAt > now then return false end
  local claimPhase = redis.call("HGET", key, "deletionClaimPhase")
  local currentPhase = redis.call("HGET", key, "deletionPhase")
  local pendingPhase = nil
  if claimPhase == "first" and currentPhase == "first_claimed" then
    pendingPhase = "first_pending"
  elseif claimPhase == "second" and currentPhase == "second_claimed" then
    pendingPhase = "second_pending"
  elseif claimPhase == "empty" and currentPhase == "empty_claimed" then
    pendingPhase = "empty_pending"
  else
    redis.call("ZREM", globalKeys.deletionClaims, key)
    return false
  end
  local tokenHash = redis.call("HGET", key, "deletionTokenHash")
  if tokenHash and redis.call("HGET", globalKeys.deletionTokens, tokenHash) == key then
    redis.call("HDEL", globalKeys.deletionTokens, tokenHash)
  end
  redis.call("ZREM", globalKeys.deletionClaims, key)
  redis.call("HSET", key,
    "state", "deleting",
    "deletionPhase", pendingPhase,
    "deletionDueAtMs", tostring(now))
  redis.call("HDEL", key,
    "deletionTokenHash", "deletionWorkerRef", "deletionLeaseExpiresAtMs", "deletionClaimPhase")
  redis.call("ZADD", globalKeys.deletions, now, key)
  return true
end
