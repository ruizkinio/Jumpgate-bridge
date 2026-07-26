-- jg-script:subtitle-commit
local globalKeys = subtitle_global_keys(1)
local artifactKeys = subtitle_artifact_keys(10)
local playbackKeys = subtitle_playback_keys(13)
local expected = {
  profileTag = ARGV[1], artifactId = ARGV[2], artifactRef = ARGV[3],
  deviceRef = ARGV[4], sessionId = ARGV[5], sessionRef = ARGV[6],
  generation = ARGV[7], contextRef = ARGV[8], contextRevision = ARGV[9],
  providerRevision = ARGV[10]
}
local tokenHash = ARGV[11]
local requestMode = ARGV[12]
local partCount = tonumber(ARGV[13])
local objectKeys = { ARGV[14], ARGV[18] }
local sizes = { ARGV[15], ARGV[19] }
local checksums = { ARGV[16], ARGV[20] }
local mediaTypes = { ARGV[17], ARGV[21] }
local maximumBytes = ARGV[22]
local logicalTtlMs = tonumber(ARGV[23])

if #KEYS ~= 17 or #ARGV ~= 23 or
   (requestMode ~= "legacy" and requestMode ~= "receipt") or
   not partCount or partCount < 1 or partCount > 2 or
   not subtitle_valid_decimal(maximumBytes, 128) or
   not logicalTtlMs or logicalTtlMs < 1 then return { "invalid_parts" } end
local total = "0"
for index = 1, partCount do
  if not subtitle_valid_decimal(sizes[index], 128) or sizes[index] == "0" or
     not subtitle_valid_digest(checksums[index]) then return { "invalid_parts" } end
  if requestMode == "receipt" then
    if type(objectKeys[index]) ~= "string" or objectKeys[index] == "" or
       type(mediaTypes[index]) ~= "string" or mediaTypes[index] == "" or
       #mediaTypes[index] > 128 then return { "invalid_parts" } end
  elseif objectKeys[index] ~= "" or mediaTypes[index] ~= "" then
    return { "invalid_parts" }
  end
  total = subtitle_decimal_add(total, sizes[index])
  if not total then return { "invalid_parts" } end
end
if partCount == 1 and
   (objectKeys[2] ~= "" or sizes[2] ~= "" or checksums[2] ~= "" or mediaTypes[2] ~= "") then
  return { "invalid_parts" }
end
local comparison = subtitle_decimal_compare(total, maximumBytes)
if comparison == nil then return { "invalid_parts" } end
if comparison > 0 then return { "artifact_too_large" } end

local globalOk, globalError = subtitle_ensure_global(globalKeys, false)
if not globalOk then return { globalError == "state_collision" and globalError or "not_found" } end
if not subtitle_artifact_matches(artifactKeys.root, expected) or
   redis.call("HGET", artifactKeys.root, "uploadTokenHash") ~= tokenHash then
  return { "not_found" }
end
local schemaVersion = subtitle_artifact_schema(artifactKeys.root)
if (schemaVersion == "2" and requestMode ~= "legacy") or
   (schemaVersion == "3" and requestMode ~= "receipt") or not schemaVersion then
  return { "commit_conflict" }
end

local function receipts_match()
  if redis.call("HGET", artifactKeys.root, "partCount") ~= tostring(partCount) or
     redis.call("HGET", artifactKeys.root, "actualBytes") ~= total then return false end
  if schemaVersion == "3" then
    local staged = subtitle_v3_parts(artifactKeys.root)
    if not staged or staged.count ~= partCount or staged.total ~= total then return false end
    for index = 1, partCount do
      local suffix = tostring(index)
      if redis.call("HGET", artifactKeys.root, "objectKey" .. suffix) ~= objectKeys[index] or
         redis.call("HGET", artifactKeys.root, "partSize" .. suffix) ~= sizes[index] or
         redis.call("HGET", artifactKeys.root, "partChecksum" .. suffix) ~= checksums[index] or
         redis.call("HGET", artifactKeys.root, "partMediaType" .. suffix) ~= mediaTypes[index] then
        return false
      end
    end
    return true
  end
  for index = 1, partCount do
    local suffix = tostring(index)
    if redis.call("HGET", artifactKeys.root, "partSize" .. suffix) ~= sizes[index] or
       redis.call("HGET", artifactKeys.root, "partChecksum" .. suffix) ~= checksums[index] then
      return false
    end
  end
  return true
end

local state = redis.call("HGET", artifactKeys.root, "state")
local uploadState = redis.call("HGET", artifactKeys.root, "uploadState")
if state == "committed" and uploadState == "complete" then
  if not receipts_match() then return { "commit_conflict" } end
  if not subtitle_authority_matches(
    globalKeys, expected.profileTag, expected.generation, expected.providerRevision
  ) then return { "not_found" } end
  local now = subtitle_now_ms()
  local active = subtitle_active_claim(playbackKeys, expected, now)
  if not active then return { "not_found" } end
  local expiresAt = subtitle_refresh_expiry(
    artifactKeys.root, now, active, logicalTtlMs, globalKeys.artifacts
  )
  if not expiresAt then return { "not_found" } end
  local replay = { "replay", expected.artifactId, tostring(expiresAt), total }
  if not subtitle_append_parts(replay, artifactKeys.root) then return { "state_collision" } end
  return replay
end
if state ~= "uploading" or uploadState ~= "active" then return { "not_found" } end

local now = subtitle_now_ms()
local uploadExpiresAt = tonumber(redis.call("HGET", artifactKeys.root, "uploadExpiresAtMs"))
if not uploadExpiresAt or uploadExpiresAt <= now then
  subtitle_terminal_abort_upload(globalKeys, artifactKeys.root, now)
  return { "not_found" }
end
if redis.call("HGET", artifactKeys.root, "deletionRequested") == "1" then
  subtitle_terminal_abort_upload(globalKeys, artifactKeys.root, now)
  return { "aborted" }
end
if not subtitle_authority_matches(
  globalKeys, expected.profileTag, expected.generation, expected.providerRevision
) then
  subtitle_terminal_abort_upload(globalKeys, artifactKeys.root, now)
  return { "not_found" }
end
local active = subtitle_active_claim(playbackKeys, expected, now)
if not active then
  subtitle_terminal_abort_upload(globalKeys, artifactKeys.root, now)
  return { "not_found" }
end
if redis.call("HGET", artifactKeys.root, "partCount") ~= tostring(partCount) then
  return { "commit_conflict" }
end

local excessObjects = "0"
local excessBytes = "0"
local profileRoot = nil
if schemaVersion == "2" then
  local quotaObjects = redis.call("HGET", artifactKeys.root, "quotaObjects")
  local quotaBytes = redis.call("HGET", artifactKeys.root, "quotaBytes")
  excessObjects = quotaObjects and
    subtitle_decimal_subtract(quotaObjects, tostring(partCount)) or nil
  excessBytes = quotaBytes and subtitle_decimal_subtract(quotaBytes, total) or nil
  profileRoot = redis.call("HGET", artifactKeys.root, "profileRootKey")
  if not excessObjects or not excessBytes or not profileRoot or
     subtitle_key_type(profileRoot) ~= "hash" then return { "state_collision" } end
  for _, check in ipairs({
    { profileRoot, "objects", excessObjects }, { profileRoot, "bytes", excessBytes },
    { globalKeys.root, "objects", excessObjects }, { globalKeys.root, "bytes", excessBytes }
  }) do
    local current = subtitle_counter(check[1], check[2])
    if not current or subtitle_decimal_compare(current, check[3]) < 0 then
      return { "state_collision" }
    end
  end
else
  if not receipts_match() or
     redis.call("HGET", artifactKeys.root, "quotaObjects") ~= tostring(partCount) or
     redis.call("HGET", artifactKeys.root, "quotaBytes") ~= total then
    return { "commit_conflict" }
  end
end

local expiresAt = subtitle_refresh_expiry(
  artifactKeys.root, now, active, logicalTtlMs, globalKeys.artifacts
)
if not expiresAt then
  subtitle_terminal_abort_upload(globalKeys, artifactKeys.root, now)
  return { "not_found" }
end
if schemaVersion == "2" then
  subtitle_decrement_counter(profileRoot, "objects", excessObjects)
  subtitle_decrement_counter(profileRoot, "bytes", excessBytes)
  subtitle_decrement_counter(globalKeys.root, "objects", excessObjects)
  subtitle_decrement_counter(globalKeys.root, "bytes", excessBytes)
  for index = 1, partCount do
    local suffix = tostring(index)
    redis.call("HSET", artifactKeys.root,
      "partSize" .. suffix, sizes[index],
      "partChecksum" .. suffix, checksums[index])
  end
  redis.call("HSET", artifactKeys.root,
    "actualBytes", total,
    "quotaObjects", tostring(partCount),
    "quotaBytes", total)
end
redis.call("HSET", artifactKeys.root,
  "state", "committed",
  "uploadState", "complete",
  "uploadTerminalAtMs", tostring(now),
  "committedAtMs", tostring(now))
redis.call("HDEL", artifactKeys.root, "sourceEnvelope", "uploadExpiresAtMs")
redis.call("ZREM", globalKeys.uploadExpiries, artifactKeys.root)
local reply = { "committed", expected.artifactId, tostring(expiresAt), total }
if not subtitle_append_parts(reply, artifactKeys.root) then return { "state_collision" } end
return reply
