-- jg-script:subtitle-stage-upload
local globalKeys = subtitle_global_keys(1)
local profileKeys = subtitle_profile_keys(10)
local artifactKeys = subtitle_artifact_keys(13)
local playbackKeys = subtitle_playback_keys(16)
local expected = {
  profileTag = ARGV[1], artifactId = ARGV[2], artifactRef = ARGV[3],
  deviceRef = ARGV[4], sessionId = ARGV[5], sessionRef = ARGV[6],
  generation = ARGV[7], contextRef = ARGV[8], contextRevision = ARGV[9],
  providerRevision = ARGV[10]
}
local fetchTokenHash = ARGV[11]
local uploadTokenHash = ARGV[12]
local attemptRef = ARGV[13]
local partCount = tonumber(ARGV[14])
local metadataVersion = ARGV[15]
local objectKeys = { ARGV[16], ARGV[22] }
local sizes = { ARGV[17], ARGV[23] }
local checksums = { ARGV[18], ARGV[24] }
local roles = { ARGV[19], ARGV[25] }
local extensions = { ARGV[20], ARGV[26] }
local mediaTypes = { ARGV[21], ARGV[27] }
local uploadTtlMs = tonumber(ARGV[28])
local maxPutLifetimeMs = tonumber(ARGV[29])
local settlementGraceMs = tonumber(ARGV[30])
local logicalTtlMs = tonumber(ARGV[31])

if #KEYS ~= 20 or #ARGV ~= 31 or not subtitle_valid_digest(fetchTokenHash) or
   not subtitle_valid_digest(uploadTokenHash) or not subtitle_valid_digest(attemptRef) or
   metadataVersion ~= "1" or not partCount or partCount < 1 or partCount > 2 or
   not uploadTtlMs or uploadTtlMs < 1 or uploadTtlMs > 120000 or
   not maxPutLifetimeMs or maxPutLifetimeMs < 1 or maxPutLifetimeMs > 120000 or
   not settlementGraceMs or settlementGraceMs < 1 or settlementGraceMs > 120000 or
   not logicalTtlMs or logicalTtlMs < 1 then return { "invalid_parts" } end
local total = "0"
for index = 1, partCount do
  if type(objectKeys[index]) ~= "string" or objectKeys[index] == "" or
     not subtitle_valid_decimal(sizes[index], 128) or sizes[index] == "0" or
     not subtitle_valid_digest(checksums[index]) or
     not subtitle_valid_part_tuple(
       partCount, index, roles[index], extensions[index], mediaTypes[index]
     ) then return { "invalid_parts" } end
  total = subtitle_decimal_add(total, sizes[index])
  if not total then return { "invalid_parts" } end
end
if partCount == 1 and
   (objectKeys[2] ~= "" or sizes[2] ~= "" or checksums[2] ~= "" or
    roles[2] ~= "" or extensions[2] ~= "" or mediaTypes[2] ~= "") then
  return { "invalid_parts" }
end

local globalOk, globalError = subtitle_ensure_global(globalKeys, false)
if not globalOk then return { globalError == "state_collision" and globalError or "not_found" } end
local profileOk, profileError = subtitle_ensure_profile(profileKeys, expected.profileTag, false)
if not profileOk then return { profileError == "state_collision" and profileError or "not_found" } end
if not subtitle_artifact_matches(artifactKeys.root, expected) then return { "not_found" } end
if subtitle_artifact_schema(artifactKeys.root) ~= "3" or
   redis.call("HGET", artifactKeys.root, "profileRootKey") ~= profileKeys.root or
   redis.call("HGET", artifactKeys.root, "profileArtifactsKey") ~= profileKeys.artifacts or
   redis.call("HGET", artifactKeys.root, "profileDiscoveriesKey") ~= profileKeys.discoveries then
  return { "stage_conflict" }
end

local state = redis.call("HGET", artifactKeys.root, "state")
local now = subtitle_now_ms()
local existingSettlesRaw = nil
if state == "uploading" then
  if redis.call("HGET", artifactKeys.root, "uploadState") ~= "active" then
    return { "stage_conflict" }
  end
  if redis.call("HGET", artifactKeys.root, "fetchTokenHash") ~= fetchTokenHash or
     redis.call("HGET", artifactKeys.root, "uploadTokenHash") ~= uploadTokenHash or
     redis.call("HGET", artifactKeys.root, "uploadAttemptRef") ~= attemptRef or
     redis.call("HGET", artifactKeys.root, "partMetadataVersion") ~= metadataVersion or
     redis.call("HGET", artifactKeys.root, "partCount") ~= tostring(partCount) or
     redis.call("HGET", artifactKeys.root, "actualBytes") ~= total then
    return { "stage_conflict" }
  end
  for index = 1, partCount do
    local suffix = tostring(index)
    if redis.call("HGET", artifactKeys.root, "objectKey" .. suffix) ~= objectKeys[index] or
       redis.call("HGET", artifactKeys.root, "partNumber" .. suffix) ~= suffix or
       redis.call("HGET", artifactKeys.root, "partSize" .. suffix) ~= sizes[index] or
       redis.call("HGET", artifactKeys.root, "partChecksum" .. suffix) ~= checksums[index] or
       redis.call("HGET", artifactKeys.root, "partRole" .. suffix) ~= roles[index] or
       redis.call("HGET", artifactKeys.root, "partExtension" .. suffix) ~= extensions[index] or
       redis.call("HGET", artifactKeys.root, "partMediaType" .. suffix) ~= mediaTypes[index] then
      return { "stage_conflict" }
    end
  end
  local uploadExpiresAtRaw = redis.call("HGET", artifactKeys.root, "uploadExpiresAtMs")
  existingSettlesRaw = redis.call("HGET", artifactKeys.root, "uploadSettlesAtMs")
  if not subtitle_valid_decimal(uploadExpiresAtRaw, 16) or
     not subtitle_valid_decimal(existingSettlesRaw, 16) then return { "state_collision" } end
  if tonumber(uploadExpiresAtRaw) <= now then
    subtitle_terminal_abort_upload(globalKeys, artifactKeys.root, now)
    return { "not_found" }
  end
  if redis.call("HGET", artifactKeys.root, "deletionRequested") == "1" then
    local aborting = {
      "aborting", expected.artifactId,
      redis.call("HGET", artifactKeys.root, "expiresAtMs"), uploadExpiresAtRaw,
      existingSettlesRaw
    }
    if not subtitle_append_parts(aborting, artifactKeys.root) then return { "state_collision" } end
    return aborting
  end
elseif state ~= "fetching" then
  return { "stage_conflict" }
else
  local fetchExpiresAtRaw = redis.call("HGET", artifactKeys.root, "fetchExpiresAtMs")
  local workScore = redis.call("ZSCORE", globalKeys.uploadExpiries, artifactKeys.root)
  if redis.call("HGET", artifactKeys.root, "fetchTokenHash") ~= fetchTokenHash then
    return { "stage_conflict" }
  end
  if not subtitle_valid_decimal(fetchExpiresAtRaw, 16) or not workScore or
     tonumber(workScore) ~= tonumber(fetchExpiresAtRaw) then return { "state_collision" } end
  if tonumber(fetchExpiresAtRaw) <= now then
    if not subtitle_reset_expired_fetch(globalKeys, artifactKeys.root, now) then
      return { "state_collision" }
    end
    return { "stage_conflict" }
  end
end

local excessObjects = nil
local excessBytes = nil
local nextUploadFence = nil
if state == "fetching" then
  local quotaObjects = redis.call("HGET", artifactKeys.root, "quotaObjects")
  local quotaBytes = redis.call("HGET", artifactKeys.root, "quotaBytes")
  excessObjects = quotaObjects and
    subtitle_decimal_subtract(quotaObjects, tostring(partCount)) or nil
  excessBytes = quotaBytes and subtitle_decimal_subtract(quotaBytes, total) or nil
  nextUploadFence = subtitle_decimal_add(
    redis.call("HGET", artifactKeys.root, "uploadFence") or "0", "1"
  )
  if not excessObjects or not excessBytes or not nextUploadFence or
     redis.call("HGET", artifactKeys.root, "reservedObjects") ~= quotaObjects or
     redis.call("HGET", artifactKeys.root, "reservedBytes") ~= quotaBytes or
     redis.call("HGET", artifactKeys.root, "partCount") ~= "0" or
     redis.call("HEXISTS", artifactKeys.root, "objectKey1") ~= 0 or
     redis.call("HEXISTS", artifactKeys.root, "partMetadataVersion") ~= 0 then
    return { "stage_conflict" }
  end
  for _, check in ipairs({
    { profileKeys.root, "objects", excessObjects },
    { profileKeys.root, "bytes", excessBytes },
    { globalKeys.root, "objects", excessObjects },
    { globalKeys.root, "bytes", excessBytes }
  }) do
    local current = subtitle_counter(check[1], check[2])
    if not current or subtitle_decimal_compare(current, check[3]) < 0 then
      return { "state_collision" }
    end
  end
else
  local staged = subtitle_v3_parts(artifactKeys.root)
  if not staged or staged.count ~= partCount or staged.total ~= total or
     redis.call("HGET", artifactKeys.root, "quotaObjects") ~= staged.countRaw or
     redis.call("HGET", artifactKeys.root, "quotaBytes") ~= staged.total then
    return { "state_collision" }
  end
end

if redis.call("HGET", artifactKeys.root, "deletionRequested") ~= "0" then
  return { "not_found" }
end
if not subtitle_authority_matches(
  globalKeys, expected.profileTag, expected.generation, expected.providerRevision
) then
  if state == "fetching" then subtitle_mark_deleting(globalKeys, artifactKeys.root, now) end
  return { "not_found" }
end
local active = subtitle_active_claim(playbackKeys, expected, now)
if not active then
  if state == "fetching" then subtitle_mark_deleting(globalKeys, artifactKeys.root, now) end
  return { "not_found" }
end
local absoluteExpiresAt = tonumber(redis.call("HGET", artifactKeys.root, "absoluteExpiresAtMs"))
local uploadExpiresAt = subtitle_minimum(
  absoluteExpiresAt,
  active.claimExpiresAtMs,
  active.contextExpiresAtMs,
  now + uploadTtlMs
)
if not uploadExpiresAt or uploadExpiresAt <= now then return { "not_found" } end
local settlesAt = uploadExpiresAt + maxPutLifetimeMs + settlementGraceMs
existingSettlesRaw = existingSettlesRaw or redis.call("HGET", artifactKeys.root, "uploadSettlesAtMs")
if existingSettlesRaw and not subtitle_valid_decimal(existingSettlesRaw, 16) then
  return { "state_collision" }
end
local existingSettlesAt = tonumber(existingSettlesRaw)
if existingSettlesAt and existingSettlesAt > settlesAt then settlesAt = existingSettlesAt end
local expiresAt = subtitle_refresh_expiry(
  artifactKeys.root, now, active, logicalTtlMs, globalKeys.artifacts
)
if not expiresAt then return { "not_found" } end

local status = "replay"
if state == "fetching" then
  subtitle_decrement_counter(profileKeys.root, "objects", excessObjects)
  subtitle_decrement_counter(profileKeys.root, "bytes", excessBytes)
  subtitle_decrement_counter(globalKeys.root, "objects", excessObjects)
  subtitle_decrement_counter(globalKeys.root, "bytes", excessBytes)
  redis.call("HSET", artifactKeys.root,
    "state", "uploading",
    "uploadState", "active",
    "uploadFence", nextUploadFence,
    "uploadTokenHash", uploadTokenHash,
    "uploadAttemptRef", attemptRef,
    "uploadStartedAtMs", tostring(now),
    "partMetadataVersion", metadataVersion,
    "partCount", tostring(partCount),
    "actualBytes", total,
    "quotaObjects", tostring(partCount),
    "quotaBytes", total)
  for index = 1, partCount do
    local suffix = tostring(index)
    redis.call("HSET", artifactKeys.root,
      "objectKey" .. suffix, objectKeys[index],
      "partNumber" .. suffix, suffix,
      "partSize" .. suffix, sizes[index],
      "partChecksum" .. suffix, checksums[index],
      "partRole" .. suffix, roles[index],
      "partExtension" .. suffix, extensions[index],
      "partMediaType" .. suffix, mediaTypes[index])
  end
  if partCount == 1 then
    redis.call("HDEL", artifactKeys.root,
      "objectKey2", "partNumber2", "partSize2", "partChecksum2",
      "partRole2", "partExtension2", "partMediaType2")
  end
  redis.call("HDEL", artifactKeys.root, "reservationTokenHash", "fetchExpiresAtMs")
  status = "uploading"
end
redis.call("HSET", artifactKeys.root,
  "uploadLastStartedAtMs", tostring(now),
  "uploadMaximumPutLifetimeMs", tostring(maxPutLifetimeMs),
  "uploadSettlementGraceMs", tostring(settlementGraceMs),
  "uploadSettlesAtMs", tostring(settlesAt),
  "uploadExpiresAtMs", tostring(uploadExpiresAt))
redis.call("ZADD", globalKeys.uploadExpiries, uploadExpiresAt, artifactKeys.root)
local reply = {
  status, expected.artifactId, tostring(expiresAt), tostring(uploadExpiresAt), tostring(settlesAt)
}
if not subtitle_append_parts(reply, artifactKeys.root) then return { "state_collision" } end
return reply
