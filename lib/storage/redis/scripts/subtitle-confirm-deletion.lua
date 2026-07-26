-- jg-script:subtitle-confirm-deletion
local globalKeys = subtitle_global_keys(1)
local artifactKeys = subtitle_artifact_keys(10)
local artifactId = ARGV[1]
local artifactRef = ARGV[2]
local tokenHash = ARGV[3]
local cleanupBatch = tonumber(ARGV[4])
if not cleanupBatch or cleanupBatch < 1 or cleanupBatch > 256 then return { "state_collision" } end
local globalOk, globalError = subtitle_ensure_global(globalKeys, false)
if not globalOk then return { globalError == "state_collision" and globalError or "not_found" } end
if not subtitle_artifact_schema(artifactKeys.root) or
   redis.call("HGET", artifactKeys.root, "artifactId") ~= artifactId or
   redis.call("HGET", artifactKeys.root, "artifactRef") ~= artifactRef or
   redis.call("HGET", artifactKeys.root, "state") ~= "deletion_claimed" or
   redis.call("HGET", artifactKeys.root, "deletionTokenHash") ~= tokenHash or
   redis.call("HGET", globalKeys.deletionTokens, tokenHash) ~= artifactKeys.root then
  return { "not_found" }
end
local deletionPhase = redis.call("HGET", artifactKeys.root, "deletionPhase")
local claimPhase = redis.call("HGET", artifactKeys.root, "deletionClaimPhase")
local emptyClaim = deletionPhase == "empty_claimed" and claimPhase == "empty"
if not emptyClaim and
   (deletionPhase ~= "second_claimed" or claimPhase ~= "second") then
  return { "deletion_barrier" }
end
local now = subtitle_now_ms()
local deletionLeaseExpiresAt = tonumber(
  redis.call("HGET", artifactKeys.root, "deletionLeaseExpiresAtMs")
)
if not deletionLeaseExpiresAt or deletionLeaseExpiresAt <= now then
  subtitle_requeue_expired_deletion_claim(globalKeys, artifactKeys.root, now)
  return { "not_found" }
end
if redis.call("HGET", artifactKeys.root, "uploadState") == "active" or
   redis.call("ZSCORE", globalKeys.uploadExpiries, artifactKeys.root) then return { "upload_barrier" } end
if emptyClaim and
   (redis.call("HGET", artifactKeys.root, "uploadState") ~= "none" or
    redis.call("HGET", artifactKeys.root, "partCount") ~= "0" or
    redis.call("HEXISTS", artifactKeys.root, "objectKey1") ~= 0 or
    redis.call("HEXISTS", artifactKeys.root, "objectKey2") ~= 0) then
  return { "state_collision" }
end
subtitle_cleanup_artifact_leases(globalKeys, artifactKeys, now, cleanupBatch)
if redis.call("ZCARD", artifactKeys.leaseExpiries) > 0 then return { "lease_busy" } end

local profileRoot = redis.call("HGET", artifactKeys.root, "profileRootKey")
local profileArtifacts = redis.call("HGET", artifactKeys.root, "profileArtifactsKey")
local profileDiscoveries = redis.call("HGET", artifactKeys.root, "profileDiscoveriesKey")
local profileTag = redis.call("HGET", artifactKeys.root, "profileTag")
local quotaObjects = redis.call("HGET", artifactKeys.root, "quotaObjects")
local quotaBytes = redis.call("HGET", artifactKeys.root, "quotaBytes")
if not profileRoot or not profileArtifacts or not profileDiscoveries or not profileTag or
   not subtitle_valid_decimal(quotaObjects, 128) or not subtitle_valid_decimal(quotaBytes, 128) then
  return { "state_collision" }
end
local profileKeys = { root = profileRoot, artifacts = profileArtifacts, discoveries = profileDiscoveries }
local profileOk, profileError = subtitle_ensure_profile(profileKeys, profileTag, false)
if not profileOk then return { profileError } end
for _, check in ipairs({
  { profileRoot, "artifacts", "1" }, { profileRoot, "objects", quotaObjects },
  { profileRoot, "bytes", quotaBytes }, { globalKeys.root, "artifacts", "1" },
  { globalKeys.root, "objects", quotaObjects }, { globalKeys.root, "bytes", quotaBytes }
}) do
  local current = subtitle_counter(check[1], check[2])
  if not current or subtitle_decimal_compare(current, check[3]) < 0 then return { "state_collision" } end
end

local discoveryRef = redis.call("HGET", artifactKeys.root, "discoveryRef")
if discoveryRef and redis.call("HGET", profileDiscoveries, discoveryRef) == artifactKeys.root then
  redis.call("HDEL", profileDiscoveries, discoveryRef)
end
redis.call("HDEL", globalKeys.deletionTokens, tokenHash)
redis.call("ZREM", globalKeys.artifacts, artifactKeys.root)
redis.call("ZREM", globalKeys.deletions, artifactKeys.root)
redis.call("ZREM", globalKeys.deletionClaims, artifactKeys.root)
redis.call("ZREM", globalKeys.uploadExpiries, artifactKeys.root)
redis.call("ZREM", profileArtifacts, artifactKeys.root)
redis.call("DEL", artifactKeys.root, artifactKeys.leaseData, artifactKeys.leaseExpiries)

local profileArtifactCount = subtitle_decrement_counter(profileRoot, "artifacts", "1")
subtitle_decrement_counter(profileRoot, "objects", quotaObjects)
subtitle_decrement_counter(profileRoot, "bytes", quotaBytes)
subtitle_decrement_counter(globalKeys.root, "artifacts", "1")
subtitle_decrement_counter(globalKeys.root, "objects", quotaObjects)
subtitle_decrement_counter(globalKeys.root, "bytes", quotaBytes)
if profileArtifactCount == "0" and subtitle_counter(profileRoot, "leases") == "0" then
  redis.call("DEL", profileRoot, profileArtifacts, profileDiscoveries)
end
return { "confirmed", "1", quotaObjects, quotaBytes }
