-- jg-script:subtitle-begin-upload
local globalKeys = subtitle_global_keys(1)
local artifactKeys = subtitle_artifact_keys(10)
local playbackKeys = subtitle_playback_keys(13)
local expected = {
  profileTag = ARGV[1], artifactId = ARGV[2], artifactRef = ARGV[3],
  deviceRef = ARGV[4], sessionId = ARGV[5], sessionRef = ARGV[6],
  generation = ARGV[7], contextRef = ARGV[8], contextRevision = ARGV[9],
  providerRevision = ARGV[10]
}
local partCount = tonumber(ARGV[11])
local tokenHash = ARGV[12]
local attemptRef = ARGV[13]
local uploadTtlMs = tonumber(ARGV[14])
local maxPutLifetimeMs = tonumber(ARGV[15])
local settlementGraceMs = tonumber(ARGV[16])
local logicalTtlMs = tonumber(ARGV[17])
local expectedEnvelope = ARGV[18]

if not partCount or partCount < 1 or partCount > 2 or
   type(tokenHash) ~= "string" or #tokenHash ~= 64 or
   type(attemptRef) ~= "string" or #attemptRef ~= 64 or
   not uploadTtlMs or uploadTtlMs < 1 or uploadTtlMs > 120000 or
   not maxPutLifetimeMs or maxPutLifetimeMs < 1 or maxPutLifetimeMs > 120000 or
   not settlementGraceMs or settlementGraceMs < 1 or settlementGraceMs > 120000 or
   not logicalTtlMs or logicalTtlMs < 1 or
   type(expectedEnvelope) ~= "string" or expectedEnvelope == "" or
   type(ARGV[19]) ~= "string" or ARGV[19] == "" or
   (partCount == 2 and (type(ARGV[20]) ~= "string" or ARGV[20] == "")) then
  return { "state_collision" }
end
local globalOk, globalError = subtitle_ensure_global(globalKeys, false)
if not globalOk then return { globalError == "state_collision" and globalError or "not_found" } end
if not subtitle_artifact_matches(artifactKeys.root, expected) then return { "not_found" } end
if subtitle_artifact_schema(artifactKeys.root) ~= "2" then return { "not_found" } end

local state = redis.call("HGET", artifactKeys.root, "state")
if state == "uploading" and redis.call("HGET", artifactKeys.root, "uploadState") == "active" then
  if redis.call("HGET", artifactKeys.root, "uploadTokenHash") ~= tokenHash then return { "upload_busy" } end
  if redis.call("HGET", artifactKeys.root, "deletionRequested") == "1" then
    local aborting = { "aborting", expected.artifactId, redis.call("HGET", artifactKeys.root, "uploadExpiresAtMs") }
    if not subtitle_append_upload_parts(aborting, artifactKeys.root) then return { "state_collision" } end
    return aborting
  end
  if redis.call("HGET", artifactKeys.root, "sourceEnvelope") ~= expectedEnvelope then return { "changed" } end
  if redis.call("HGET", artifactKeys.root, "partCount") ~= tostring(partCount) or
     redis.call("HGET", artifactKeys.root, "uploadAttemptRef") ~= attemptRef then
    return { "upload_conflict" }
  end
  for index = 1, partCount do
    if redis.call("HGET", artifactKeys.root, "objectKey" .. tostring(index)) ~= ARGV[18 + index] then
      return { "upload_conflict" }
    end
  end
elseif state ~= "reserved" or redis.call("HGET", artifactKeys.root, "deletionRequested") ~= "0" then
  return { "not_found" }
elseif redis.call("HGET", artifactKeys.root, "sourceEnvelope") ~= expectedEnvelope then
  return { "changed" }
end

if not subtitle_authority_matches(globalKeys, expected.profileTag, expected.generation, expected.providerRevision) then
  return { "not_found" }
end
local now = subtitle_now_ms()
local active = subtitle_active_claim(playbackKeys, expected, now)
if not active then return { "not_found" } end
local absoluteExpiresAt = tonumber(redis.call("HGET", artifactKeys.root, "absoluteExpiresAtMs"))
local uploadExpiresAt = subtitle_minimum(
  absoluteExpiresAt,
  active.claimExpiresAtMs,
  active.contextExpiresAtMs,
  now + uploadTtlMs
)
if not uploadExpiresAt or uploadExpiresAt <= now then return { "not_found" } end
local expiresAt = subtitle_refresh_expiry(artifactKeys.root, now, active, logicalTtlMs, globalKeys.artifacts)
if not expiresAt then return { "not_found" } end
-- A worker may start its PUT at the end of the upload lease. Keep deletion
-- fenced until that latest start can no longer settle, plus propagation grace.
local settlesAt = uploadExpiresAt + maxPutLifetimeMs + settlementGraceMs
local existingSettlesRaw = redis.call("HGET", artifactKeys.root, "uploadSettlesAtMs")
if existingSettlesRaw and not subtitle_valid_decimal(existingSettlesRaw, 16) then
  return { "state_collision" }
end
local existingSettlesAt = tonumber(existingSettlesRaw)
if existingSettlesAt and existingSettlesAt > settlesAt then settlesAt = existingSettlesAt end

local status = "replay"
if state == "reserved" then
  local fence = subtitle_decimal_add(redis.call("HGET", artifactKeys.root, "uploadFence") or "0", "1")
  if not fence then return { "state_collision" } end
  redis.call("HSET", artifactKeys.root,
    "state", "uploading",
    "uploadState", "active",
    "uploadFence", fence,
    "uploadTokenHash", tokenHash,
    "uploadAttemptRef", attemptRef,
    "uploadStartedAtMs", tostring(now),
    "uploadLastStartedAtMs", tostring(now),
    "uploadMaximumPutLifetimeMs", tostring(maxPutLifetimeMs),
    "uploadSettlementGraceMs", tostring(settlementGraceMs),
    "uploadSettlesAtMs", tostring(settlesAt),
    "partCount", tostring(partCount),
    "objectKey1", ARGV[19])
  if partCount == 2 then redis.call("HSET", artifactKeys.root, "objectKey2", ARGV[20])
  else redis.call("HDEL", artifactKeys.root, "objectKey2") end
  redis.call("HDEL", artifactKeys.root, "reservationTokenHash")
  status = "uploading"
else
  redis.call("HSET", artifactKeys.root,
    "uploadLastStartedAtMs", tostring(now),
    "uploadMaximumPutLifetimeMs", tostring(maxPutLifetimeMs),
    "uploadSettlementGraceMs", tostring(settlementGraceMs),
    "uploadSettlesAtMs", tostring(settlesAt))
end
redis.call("HSET", artifactKeys.root, "uploadExpiresAtMs", tostring(uploadExpiresAt))
redis.call("ZADD", globalKeys.uploadExpiries, uploadExpiresAt, artifactKeys.root)
local reply = { status, expected.artifactId, tostring(expiresAt), tostring(uploadExpiresAt) }
if not subtitle_append_upload_parts(reply, artifactKeys.root) then return { "state_collision" } end
return reply
