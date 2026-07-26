-- jg-script:subtitle-cancel-reservation
local globalKeys = subtitle_global_keys(1)
local profileKeys = subtitle_profile_keys(10)
local artifactKeys = subtitle_artifact_keys(13)
local expected = {
  profileTag = ARGV[1],
  artifactId = ARGV[2],
  artifactRef = ARGV[3],
  deviceRef = ARGV[4],
  sessionRef = ARGV[6],
  generation = ARGV[7],
  contextRef = ARGV[8],
  contextRevision = ARGV[9],
  providerRevision = ARGV[10]
}
local reservationTokenHash = ARGV[11]
local fetchTokenHash = ARGV[12]

if #KEYS ~= 15 or #ARGV ~= 12 or
   (reservationTokenHash ~= "" and not subtitle_valid_digest(reservationTokenHash)) or
   (fetchTokenHash ~= "" and not subtitle_valid_digest(fetchTokenHash)) or
   (reservationTokenHash == "" and fetchTokenHash == "") then
  return { "state_collision" }
end

local globalOk, globalError = subtitle_ensure_global(globalKeys, false)
if not globalOk then
  if globalError == "not_found" then return { "not_found" } end
  return { globalError }
end
local profileOk, profileError = subtitle_ensure_profile(profileKeys, expected.profileTag, false)
if not profileOk then
  if profileError == "not_found" then return { "not_found" } end
  return { profileError }
end
if not subtitle_artifact_matches(artifactKeys.root, expected) then return { "not_found" } end

local state = redis.call("HGET", artifactKeys.root, "state")
local ownsReservation = state == "reserved" and reservationTokenHash ~= "" and
  redis.call("HGET", artifactKeys.root, "reservationTokenHash") == reservationTokenHash
local ownsFetch = state == "fetching" and fetchTokenHash ~= "" and
  redis.call("HGET", artifactKeys.root, "fetchTokenHash") == fetchTokenHash
local ownsFencedFetch = state == "reserved" and fetchTokenHash ~= "" and
  redis.call("HGET", artifactKeys.root, "fetchFencedTokenHash") == fetchTokenHash
if (not ownsReservation and not ownsFetch and not ownsFencedFetch) or
   redis.call("HGET", artifactKeys.root, "uploadState") ~= "none" or
   redis.call("HGET", artifactKeys.root, "deletionRequested") ~= "0" or
   (state ~= "reserved" and state ~= "fetching") then
  return { "not_found" }
end
if redis.call("HGET", artifactKeys.root, "profileRootKey") ~= profileKeys.root or
   redis.call("HGET", artifactKeys.root, "profileArtifactsKey") ~= profileKeys.artifacts or
   redis.call("HGET", artifactKeys.root, "profileDiscoveriesKey") ~= profileKeys.discoveries or
   redis.call("HGET", artifactKeys.root, "artifactLeaseDataKey") ~= artifactKeys.leaseData or
   redis.call("HGET", artifactKeys.root, "artifactLeaseExpiriesKey") ~= artifactKeys.leaseExpiries or
   redis.call("HGET", artifactKeys.root, "partCount") ~= "0" or
   redis.call("HEXISTS", artifactKeys.root, "objectKey1") ~= 0 or
   redis.call("HEXISTS", artifactKeys.root, "objectKey2") ~= 0 or
   redis.call("HEXISTS", artifactKeys.root, "uploadTokenHash") ~= 0 or
   redis.call("HEXISTS", artifactKeys.root, "uploadAttemptRef") ~= 0 or
   redis.call("HEXISTS", artifactKeys.root, "uploadStartedAtMs") ~= 0 or
   redis.call("HEXISTS", artifactKeys.root, "partMetadataVersion") ~= 0 or
   subtitle_key_type(artifactKeys.leaseData) ~= "none" or
   subtitle_key_type(artifactKeys.leaseExpiries) ~= "none" then
  return { "state_collision" }
end
local workScore = redis.call("ZSCORE", globalKeys.uploadExpiries, artifactKeys.root)
if state == "fetching" then
  local fetchExpiresAt = redis.call("HGET", artifactKeys.root, "fetchExpiresAtMs")
  if subtitle_artifact_schema(artifactKeys.root) ~= "3" or
     not subtitle_valid_decimal(fetchExpiresAt, 16) or not workScore or
     tonumber(workScore) ~= tonumber(fetchExpiresAt) then return { "state_collision" } end
elseif redis.call("HEXISTS", artifactKeys.root, "fetchTokenHash") ~= 0 or
       redis.call("HEXISTS", artifactKeys.root, "fetchExpiresAtMs") ~= 0 or workScore then
  return { "state_collision" }
end

local quotaObjects = redis.call("HGET", artifactKeys.root, "quotaObjects")
local quotaBytes = redis.call("HGET", artifactKeys.root, "quotaBytes")
if not subtitle_valid_decimal(quotaObjects, 4) or not subtitle_valid_decimal(quotaBytes, 128) or
   redis.call("HGET", artifactKeys.root, "reservedObjects") ~= quotaObjects or
   redis.call("HGET", artifactKeys.root, "reservedBytes") ~= quotaBytes then
  return { "state_collision" }
end
for _, counter in ipairs({
  { profileKeys.root, "artifacts", "1" },
  { profileKeys.root, "objects", quotaObjects },
  { profileKeys.root, "bytes", quotaBytes },
  { globalKeys.root, "artifacts", "1" },
  { globalKeys.root, "objects", quotaObjects },
  { globalKeys.root, "bytes", quotaBytes }
}) do
  local current = subtitle_counter(counter[1], counter[2])
  if not current or subtitle_decimal_compare(current, counter[3]) < 0 then
    return { "state_collision" }
  end
end

subtitle_remove_active_indexes(globalKeys, artifactKeys.root)
redis.call("ZREM", globalKeys.uploadExpiries, artifactKeys.root)
subtitle_decrement_counter(profileKeys.root, "artifacts", "1")
subtitle_decrement_counter(profileKeys.root, "objects", quotaObjects)
subtitle_decrement_counter(profileKeys.root, "bytes", quotaBytes)
subtitle_decrement_counter(globalKeys.root, "artifacts", "1")
subtitle_decrement_counter(globalKeys.root, "objects", quotaObjects)
subtitle_decrement_counter(globalKeys.root, "bytes", quotaBytes)
redis.call("DEL", artifactKeys.root)

return { "canceled", expected.artifactId, "1", quotaObjects, quotaBytes }
