-- jg-script:subtitle-begin-fetch
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
local fetchTtlMs = tonumber(ARGV[12])
local logicalTtlMs = tonumber(ARGV[13])
local expectedEnvelope = ARGV[14]
local maximumParts = ARGV[15]
local maximumBytes = ARGV[16]
if #KEYS ~= 17 or #ARGV ~= 16 or not subtitle_valid_digest(tokenHash) or
   not fetchTtlMs or fetchTtlMs < 1 or fetchTtlMs > 120000 or
   not logicalTtlMs or logicalTtlMs < 1 or
   type(expectedEnvelope) ~= "string" or expectedEnvelope == "" or
   not subtitle_valid_decimal(maximumParts, 4) or maximumParts == "0" or
   not subtitle_valid_decimal(maximumBytes, 128) or maximumBytes == "0" then
  return { "state_collision" }
end
local globalOk, globalError = subtitle_ensure_global(globalKeys, false)
if not globalOk then return { globalError == "state_collision" and globalError or "not_found" } end
if not subtitle_artifact_matches(artifactKeys.root, expected) then return { "not_found" } end
if redis.call("HGET", artifactKeys.root, "sourceEnvelope") ~= expectedEnvelope then
  return { "changed" }
end

local now = subtitle_now_ms()
local schemaVersion = subtitle_artifact_schema(artifactKeys.root)
local state = redis.call("HGET", artifactKeys.root, "state")
local replay = false
if schemaVersion == "3" and state == "fetching" then
  local activeTokenHash = redis.call("HGET", artifactKeys.root, "fetchTokenHash")
  local fetchExpiresAtRaw = redis.call("HGET", artifactKeys.root, "fetchExpiresAtMs")
  local workScore = redis.call("ZSCORE", globalKeys.uploadExpiries, artifactKeys.root)
  if not subtitle_valid_digest(activeTokenHash) or
     not subtitle_valid_decimal(fetchExpiresAtRaw, 16) or not workScore or
     tonumber(workScore) ~= tonumber(fetchExpiresAtRaw) then return { "state_collision" } end
  if tonumber(fetchExpiresAtRaw) > now then
    if activeTokenHash ~= tokenHash then return { "fetch_busy" } end
    replay = true
  else
    if not subtitle_reset_expired_fetch(globalKeys, artifactKeys.root, now) then
      return { "state_collision" }
    end
    state = "reserved"
    if activeTokenHash == tokenHash then return { "fetch_conflict" } end
  end
end
if state ~= "reserved" and not replay then return { "not_found" } end
if redis.call("HGET", artifactKeys.root, "deletionRequested") ~= "0" then return { "not_found" } end

if schemaVersion == "2" then
  if redis.call("HGET", artifactKeys.root, "uploadState") ~= "none" or
     redis.call("HGET", artifactKeys.root, "partCount") ~= "0" or
     redis.call("HGET", artifactKeys.root, "reservedObjects") ~= maximumParts or
     redis.call("HGET", artifactKeys.root, "quotaObjects") ~= maximumParts or
     redis.call("HGET", artifactKeys.root, "reservedBytes") ~= maximumBytes or
     redis.call("HGET", artifactKeys.root, "quotaBytes") ~= maximumBytes or
     redis.call("HEXISTS", artifactKeys.root, "objectKey1") ~= 0 or
     redis.call("HEXISTS", artifactKeys.root, "objectKey2") ~= 0 or
     redis.call("HEXISTS", artifactKeys.root, "partMetadataVersion") ~= 0 or
     redis.call("ZSCORE", globalKeys.uploadExpiries, artifactKeys.root) then
    return { "state_collision" }
  end
elseif schemaVersion ~= "3" then
  return { "state_collision" }
end
local fetchFence = redis.call("HGET", artifactKeys.root, "fetchFence") or "0"
if not subtitle_valid_decimal(fetchFence, 128) then return { "state_collision" } end
if not replay then
  if redis.call("HGET", artifactKeys.root, "fetchFencedTokenHash") == tokenHash then
    return { "fetch_conflict" }
  end
  fetchFence = subtitle_decimal_add(fetchFence, "1")
  if not fetchFence then return { "state_collision" } end
end
if not subtitle_authority_matches(
  globalKeys, expected.profileTag, expected.generation, expected.providerRevision
) then return { "not_found" } end
local active = subtitle_active_claim(playbackKeys, expected, now)
if not active then return { "not_found" } end
local absoluteExpiresAt = tonumber(redis.call("HGET", artifactKeys.root, "absoluteExpiresAtMs"))
local fetchExpiresAt = subtitle_minimum(
  absoluteExpiresAt,
  active.claimExpiresAtMs,
  active.contextExpiresAtMs,
  now + fetchTtlMs
)
if not fetchExpiresAt or fetchExpiresAt <= now then return { "not_found" } end
local expiresAt = subtitle_refresh_expiry(
  artifactKeys.root, now, active, logicalTtlMs, globalKeys.artifacts
)
if not expiresAt then return { "not_found" } end
if not replay then
  redis.call("HSET", artifactKeys.root,
    "schemaVersion", "3",
    "state", "fetching",
    "fetchFence", fetchFence,
    "fetchTokenHash", tokenHash)
end
redis.call("HSET", artifactKeys.root, "fetchExpiresAtMs", tostring(fetchExpiresAt))
redis.call("ZADD", globalKeys.uploadExpiries, fetchExpiresAt, artifactKeys.root)
return {
  replay and "replay" or "fetching",
  expected.artifactId,
  tostring(expiresAt),
  tostring(fetchExpiresAt),
  fetchFence,
  "3"
}
