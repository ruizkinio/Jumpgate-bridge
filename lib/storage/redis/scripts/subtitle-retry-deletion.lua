-- jg-script:subtitle-retry-deletion
local globalKeys = subtitle_global_keys(1)
local artifactKey = KEYS[10]
local artifactId = ARGV[1]
local artifactRef = ARGV[2]
local tokenHash = ARGV[3]
local retryDelayMs = tonumber(ARGV[4])
if not retryDelayMs or retryDelayMs < 1 then return { "state_collision" } end
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
local now = subtitle_now_ms()
local leaseExpiresAt = tonumber(redis.call("HGET", artifactKey, "deletionLeaseExpiresAtMs"))
if not leaseExpiresAt or leaseExpiresAt <= now then
  subtitle_requeue_expired_deletion_claim(globalKeys, artifactKey, now)
  return { "not_found" }
end
if redis.call("HGET", artifactKey, "uploadState") == "active" or
   redis.call("ZSCORE", globalKeys.uploadExpiries, artifactKey) then return { "upload_barrier" } end
local claimPhase = redis.call("HGET", artifactKey, "deletionClaimPhase")
local deletionPhase = redis.call("HGET", artifactKey, "deletionPhase")
local pendingPhase = nil
if claimPhase == "first" and deletionPhase == "first_claimed" then pendingPhase = "first_pending"
elseif claimPhase == "second" and deletionPhase == "second_claimed" then pendingPhase = "second_pending"
elseif claimPhase == "empty" and deletionPhase == "empty_claimed" then pendingPhase = "empty_pending"
else return { "deletion_barrier" } end
local retryAt = now + retryDelayMs
local nextAttempt = subtitle_decimal_add(redis.call("HGET", artifactKey, "deletionAttempt") or "0", "1")
if not nextAttempt then return { "state_collision" } end
redis.call("HDEL", globalKeys.deletionTokens, tokenHash)
redis.call("ZREM", globalKeys.deletionClaims, artifactKey)
redis.call("ZADD", globalKeys.deletions, retryAt, artifactKey)
redis.call("HSET", artifactKey,
  "state", "deleting", "deletionPhase", pendingPhase, "deletionDueAtMs", tostring(retryAt))
redis.call("HDEL", artifactKey,
  "deletionTokenHash", "deletionWorkerRef", "deletionLeaseExpiresAtMs", "deletionClaimPhase")
return { "retrying", nextAttempt, tostring(retryAt) }
