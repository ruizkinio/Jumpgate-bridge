-- jg-script:subtitle-record-deletion-absence
local globalKeys = subtitle_global_keys(1)
local artifactKey = KEYS[10]
local artifactId = ARGV[1]
local artifactRef = ARGV[2]
local tokenHash = ARGV[3]
local verificationDelayMs = tonumber(ARGV[4])
if not verificationDelayMs or verificationDelayMs < 1 or verificationDelayMs > 120000 then
  return { "state_collision" }
end
local globalOk, globalError = subtitle_ensure_global(globalKeys, false)
if not globalOk then return { globalError == "state_collision" and globalError or "not_found" } end
if not subtitle_artifact_schema(artifactKey) or
   redis.call("HGET", artifactKey, "artifactId") ~= artifactId or
   redis.call("HGET", artifactKey, "artifactRef") ~= artifactRef or
   redis.call("HGET", artifactKey, "state") ~= "deletion_claimed" or
   redis.call("HGET", artifactKey, "deletionTokenHash") ~= tokenHash or
   redis.call("HGET", globalKeys.deletionTokens, tokenHash) ~= artifactKey then
  return { "not_found" }
end
if redis.call("HGET", artifactKey, "deletionPhase") ~= "first_claimed" or
   redis.call("HGET", artifactKey, "deletionClaimPhase") ~= "first" then
  return { "deletion_barrier" }
end
local now = subtitle_now_ms()
local leaseExpiresAt = tonumber(redis.call("HGET", artifactKey, "deletionLeaseExpiresAtMs"))
if not leaseExpiresAt or leaseExpiresAt <= now then
  subtitle_requeue_expired_deletion_claim(globalKeys, artifactKey, now)
  return { "not_found" }
end
if redis.call("HGET", artifactKey, "uploadState") == "active" or
   redis.call("ZSCORE", globalKeys.uploadExpiries, artifactKey) then
  return { "upload_barrier" }
end
local uploadState = redis.call("HGET", artifactKey, "uploadState")
if uploadState == "aborted" or uploadState == "complete" then
  local settlesAtRaw = redis.call("HGET", artifactKey, "uploadSettlesAtMs")
  if not subtitle_valid_decimal(settlesAtRaw, 16) then return { "state_collision" } end
  local settlesAt = tonumber(settlesAtRaw)
  if not settlesAt or settlesAt > now then return { "upload_barrier" } end
end

local secondDeleteAt = now + verificationDelayMs
redis.call("HDEL", globalKeys.deletionTokens, tokenHash)
redis.call("ZREM", globalKeys.deletionClaims, artifactKey)
redis.call("ZADD", globalKeys.deletions, secondDeleteAt, artifactKey)
redis.call("HSET", artifactKey,
  "state", "deleting",
  "deletionPhase", "second_pending",
  "firstAbsenceVerifiedAtMs", tostring(now),
  "secondDeleteNotBeforeMs", tostring(secondDeleteAt),
  "deletionDueAtMs", tostring(secondDeleteAt))
redis.call("HDEL", artifactKey,
  "deletionTokenHash", "deletionWorkerRef", "deletionLeaseExpiresAtMs", "deletionClaimPhase")
return { "awaiting_second_pass", tostring(secondDeleteAt) }
