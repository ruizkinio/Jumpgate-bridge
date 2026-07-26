-- jg-script:subtitle-reserve
local globalKeys = subtitle_global_keys(1)
local profileKeys = subtitle_profile_keys(10)
local artifactKeys = subtitle_artifact_keys(13)
local playbackKeys = subtitle_playback_keys(16)
local expected = {
  profileTag = ARGV[1],
  deviceRef = ARGV[5],
  sessionId = ARGV[6],
  sessionRef = ARGV[7],
  generation = ARGV[8],
  contextRef = ARGV[9],
  contextRevision = ARGV[10],
  providerRevision = ARGV[11]
}
local artifactId = ARGV[2]
local artifactRef = ARGV[3]
local discoveryRef = ARGV[4]
local reservedBytes = ARGV[12]
local reservedObjects = ARGV[13]
local sourceEnvelope = ARGV[14]
local sourceCapabilityDigest = ARGV[15]
local reservationTokenHash = ARGV[16]
local logicalTtlMs = tonumber(ARGV[23])
local absoluteTtlMs = tonumber(ARGV[24])
local expectedDuplicateArtifactRef = ARGV[25]
local expectedDuplicateEnvelope = ARGV[26]

if #ARGV ~= 26 or type(sourceEnvelope) ~= "string" or
   #sourceEnvelope < 2 or #sourceEnvelope > 1048576 or
   type(sourceCapabilityDigest) ~= "string" or #sourceCapabilityDigest ~= 64 or
   string.match(sourceCapabilityDigest, "^[a-f0-9]+$") == nil or
   type(reservationTokenHash) ~= "string" or #reservationTokenHash ~= 64 or
   string.match(reservationTokenHash, "^[a-f0-9]+$") == nil or
   type(expectedDuplicateArtifactRef) ~= "string" or
   type(expectedDuplicateEnvelope) ~= "string" or
   (expectedDuplicateArtifactRef == "" and expectedDuplicateEnvelope ~= "") or
   (expectedDuplicateArtifactRef ~= "" and
     (#expectedDuplicateArtifactRef ~= 64 or
      string.match(expectedDuplicateArtifactRef, "^[a-f0-9]+$") == nil or
      #expectedDuplicateEnvelope > 1048576)) or
   not subtitle_valid_decimal(reservedBytes, 128) or
   not subtitle_valid_decimal(reservedObjects, 4) or
   not logicalTtlMs or logicalTtlMs < 1 or not absoluteTtlMs or absoluteTtlMs < logicalTtlMs then
  return { "state_collision" }
end

local globalOk, globalError = subtitle_ensure_global(globalKeys, false)
if not globalOk then return { globalError == "not_found" and "not_found" or globalError } end
if not subtitle_authority_matches(globalKeys, expected.profileTag, expected.generation, expected.providerRevision) then
  return { "not_found" }
end
local now = subtitle_now_ms()
local active = subtitle_active_claim(playbackKeys, expected, now)
if not active then return { "not_found" } end

local profileOk, profileError = subtitle_ensure_profile(profileKeys, expected.profileTag, true)
if not profileOk then return { profileError } end

local existingKey = redis.call("HGET", profileKeys.discoveries, discoveryRef)
if existingKey then
  local existingExpected = {
    profileTag = expected.profileTag,
    deviceRef = expected.deviceRef,
    sessionRef = expected.sessionRef,
    generation = expected.generation,
    contextRef = expected.contextRef,
    contextRevision = expected.contextRevision,
    providerRevision = expected.providerRevision
  }
  if subtitle_artifact_binding_matches(existingKey, existingExpected) and
     redis.call("HGET", existingKey, "deletionRequested") == "0" then
    local state = redis.call("HGET", existingKey, "state")
    if state == "reserved" or state == "fetching" or
       state == "uploading" or state == "committed" then
      local existingArtifactId = redis.call("HGET", existingKey, "artifactId")
      local existingArtifactRef = redis.call("HGET", existingKey, "artifactRef")
      local existingEnvelope = redis.call("HGET", existingKey, "sourceEnvelope") or ""
      local existingDigest = redis.call("HGET", existingKey, "sourceCapabilityDigest")
      if not existingArtifactId or not existingArtifactRef or
         (state ~= "committed" and #existingEnvelope < 2) or
         type(existingDigest) ~= "string" or #existingDigest ~= 64 or
         string.match(existingDigest, "^[a-f0-9]+$") == nil then
        return { "state_collision" }
      end
      if expectedDuplicateArtifactRef == "" then
        return {
          "duplicate_challenge", existingArtifactId, existingArtifactRef, state, existingEnvelope
        }
      end
      if existingArtifactRef ~= expectedDuplicateArtifactRef or
         existingEnvelope ~= expectedDuplicateEnvelope or
         existingDigest ~= sourceCapabilityDigest then
        return { "source_conflict" }
      end
      local expiresAt = subtitle_refresh_expiry(existingKey, now, active, logicalTtlMs, globalKeys.artifacts)
      if not expiresAt then
        subtitle_mark_deleting(globalKeys, existingKey, now)
        return { "not_found" }
      end
      local reply = {
        "duplicate",
        existingArtifactId,
        state,
        tostring(expiresAt),
        state == "reserved" and "1" or "0"
      }
      if state == "reserved" then
        redis.call("HSET", existingKey, "reservationTokenHash", reservationTokenHash)
      end
      if not subtitle_append_parts(reply, existingKey) then return { "state_collision" } end
      return reply
    end
  end
  if expectedDuplicateArtifactRef ~= "" then return { "not_found" } end
  redis.call("HDEL", profileKeys.discoveries, discoveryRef)
end

if expectedDuplicateArtifactRef ~= "" then return { "not_found" } end

if subtitle_key_type(artifactKeys.root) ~= "none" or
   subtitle_key_type(artifactKeys.leaseData) ~= "none" or
   subtitle_key_type(artifactKeys.leaseExpiries) ~= "none" then
  return { "artifact_collision" }
end

for _, check in ipairs({
  { profileKeys.root, "artifacts", "1", ARGV[17], "profile_capacity" },
  { profileKeys.root, "objects", reservedObjects, ARGV[18], "profile_capacity" },
  { profileKeys.root, "bytes", reservedBytes, ARGV[19], "profile_capacity" },
  { globalKeys.root, "artifacts", "1", ARGV[20], "global_capacity" },
  { globalKeys.root, "objects", reservedObjects, ARGV[21], "global_capacity" },
  { globalKeys.root, "bytes", reservedBytes, ARGV[22], "global_capacity" }
}) do
  local exceeds = subtitle_would_exceed(check[1], check[2], check[3], check[4])
  if exceeds == nil then return { "state_collision" } end
  if exceeds then return { check[5] } end
end

local absoluteExpiresAt = subtitle_minimum(active.claimExpiresAtMs, active.contextExpiresAtMs, now + absoluteTtlMs)
local expiresAt = subtitle_minimum(absoluteExpiresAt, now + logicalTtlMs)
if not absoluteExpiresAt or not expiresAt or expiresAt <= now then return { "not_found" } end

redis.call("HSET", artifactKeys.root,
  "schemaVersion", "3",
  "artifactId", artifactId,
  "artifactRef", artifactRef,
  "profileTag", expected.profileTag,
  "deviceRef", expected.deviceRef,
  "sessionRef", expected.sessionRef,
  "generation", expected.generation,
  "contextRef", expected.contextRef,
  "contextRevision", expected.contextRevision,
  "providerRevision", expected.providerRevision,
  "discoveryRef", discoveryRef,
  "profileRootKey", profileKeys.root,
  "profileArtifactsKey", profileKeys.artifacts,
  "profileDiscoveriesKey", profileKeys.discoveries,
  "artifactLeaseDataKey", artifactKeys.leaseData,
  "artifactLeaseExpiriesKey", artifactKeys.leaseExpiries,
  "state", "reserved",
  "deletionRequested", "0",
  "uploadState", "none",
  "uploadFence", "0",
  "fetchFence", "0",
  "deletionPhase", "none",
  "deletionAttempt", "0",
  "reservedObjects", reservedObjects,
  "reservedBytes", reservedBytes,
  "quotaObjects", reservedObjects,
  "quotaBytes", reservedBytes,
  "partCount", "0",
  "reservationTokenHash", reservationTokenHash,
  "sourceEnvelope", sourceEnvelope,
  "sourceCapabilityDigest", sourceCapabilityDigest,
  "createdAtMs", tostring(now),
  "expiresAtMs", tostring(expiresAt),
  "absoluteExpiresAtMs", tostring(absoluteExpiresAt))
redis.call("HSET", profileKeys.discoveries, discoveryRef, artifactKeys.root)
redis.call("ZADD", profileKeys.artifacts, expiresAt, artifactKeys.root)
redis.call("ZADD", globalKeys.artifacts, expiresAt, artifactKeys.root)

subtitle_increment_counter(profileKeys.root, "artifacts", "1")
subtitle_increment_counter(profileKeys.root, "objects", reservedObjects)
subtitle_increment_counter(profileKeys.root, "bytes", reservedBytes)
subtitle_increment_counter(globalKeys.root, "artifacts", "1")
subtitle_increment_counter(globalKeys.root, "objects", reservedObjects)
subtitle_increment_counter(globalKeys.root, "bytes", reservedBytes)

return { "reserved", artifactId, tostring(expiresAt), tostring(absoluteExpiresAt) }
