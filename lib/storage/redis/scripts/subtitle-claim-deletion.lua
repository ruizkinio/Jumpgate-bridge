-- jg-script:subtitle-claim-deletion
local globalKeys = subtitle_global_keys(1)
local tokenHash = ARGV[1]
local workerRef = ARGV[2]
local leaseTtlMs = tonumber(ARGV[3])
local scanBatch = tonumber(ARGV[4])
local cleanupBatch = tonumber(ARGV[5])
if type(tokenHash) ~= "string" or #tokenHash ~= 64 or
   not leaseTtlMs or leaseTtlMs < 1 or
   not scanBatch or scanBatch < 1 or scanBatch > 256 or
   not cleanupBatch or cleanupBatch < 1 or cleanupBatch > 256 then
  return { "state_collision" }
end
local globalOk, globalError = subtitle_ensure_global(globalKeys, false)
if not globalOk then
  if globalError == "not_found" then return { "empty" } end
  return { globalError }
end
if redis.call("HGET", globalKeys.deletionTokens, tokenHash) then return { "token_collision" } end
local now = subtitle_now_ms()
subtitle_cleanup_global_leases(globalKeys, now, cleanupBatch)

local expiredClaims = redis.call(
  "ZRANGEBYSCORE", globalKeys.deletionClaims, "-inf", now, "LIMIT", 0, scanBatch
)
for _, artifactKey in ipairs(expiredClaims) do
  subtitle_requeue_expired_deletion_claim(globalKeys, artifactKey, now)
end

local due = redis.call("ZRANGEBYSCORE", globalKeys.deletions, "-inf", now, "LIMIT", 0, scanBatch)
for _, artifactKey in ipairs(due) do
  if not subtitle_artifact_schema(artifactKey) or
     redis.call("HGET", artifactKey, "state") ~= "deleting" or
     redis.call("HGET", artifactKey, "deletionRequested") ~= "1" then
    redis.call("ZREM", globalKeys.deletions, artifactKey)
  elseif redis.call("HGET", artifactKey, "uploadState") == "active" or
         redis.call("ZSCORE", globalKeys.uploadExpiries, artifactKey) then
    redis.call("ZREM", globalKeys.deletions, artifactKey)
  else
    local deletionPhase = redis.call("HGET", artifactKey, "deletionPhase")
    local claimPhase = nil
    if deletionPhase == "first_pending" then claimPhase = "first"
    elseif deletionPhase == "second_pending" then claimPhase = "second"
    elseif deletionPhase == "empty_pending" then claimPhase = "empty"
    else
      redis.call("ZREM", globalKeys.deletions, artifactKey)
    end
    local dueAtRaw = redis.call("HGET", artifactKey, "deletionDueAtMs")
    if claimPhase and not subtitle_valid_decimal(dueAtRaw, 16) then return { "state_collision" } end
    local dueAt = claimPhase and tonumber(dueAtRaw) or nil
    if claimPhase and (not dueAt or dueAt > now) then
      redis.call("ZADD", globalKeys.deletions, dueAt or now, artifactKey)
      claimPhase = nil
    end
    local settlesAtRaw = redis.call("HGET", artifactKey, "uploadSettlesAtMs")
    local uploadState = redis.call("HGET", artifactKey, "uploadState")
    if claimPhase == "first" and (uploadState == "aborted" or uploadState == "complete") then
      if not subtitle_valid_decimal(settlesAtRaw, 16) then return { "state_collision" } end
      local settlesAt = tonumber(settlesAtRaw)
      if not settlesAt then return { "state_collision" } end
      if settlesAt > now then
        redis.call("HSET", artifactKey, "deletionDueAtMs", tostring(settlesAt))
        redis.call("ZADD", globalKeys.deletions, settlesAt, artifactKey)
        claimPhase = nil
      end
    end
    if claimPhase then
    local partReply = {}
    if not subtitle_append_parts(partReply, artifactKey) then return { "state_collision" } end
    local artifactLeaseData = redis.call("HGET", artifactKey, "artifactLeaseDataKey")
    local artifactLeaseExpiries = redis.call("HGET", artifactKey, "artifactLeaseExpiriesKey")
    if not artifactLeaseData or not artifactLeaseExpiries then return { "state_collision" } end
    local artifactKeys = {
      root = artifactKey,
      leaseData = artifactLeaseData,
      leaseExpiries = artifactLeaseExpiries
    }
    subtitle_cleanup_artifact_leases(globalKeys, artifactKeys, now, cleanupBatch)
    if redis.call("ZCARD", artifactLeaseExpiries) > 0 then
      local nextLease = redis.call("ZRANGE", artifactLeaseExpiries, 0, 0, "WITHSCORES")
      if nextLease[2] then redis.call("ZADD", globalKeys.deletions, nextLease[2], artifactKey) end
    else
      local attempt = subtitle_decimal_add(redis.call("HGET", artifactKey, "deletionAttempt") or "0", "1")
      if not attempt then return { "state_collision" } end
      local leaseExpiresAt = now + leaseTtlMs
      redis.call("ZREM", globalKeys.deletions, artifactKey)
      redis.call("ZADD", globalKeys.deletionClaims, leaseExpiresAt, artifactKey)
      redis.call("HSET", globalKeys.deletionTokens, tokenHash, artifactKey)
      redis.call("HSET", artifactKey,
        "state", "deletion_claimed",
        "deletionPhase", claimPhase .. "_claimed",
        "deletionClaimPhase", claimPhase,
        "deletionAttempt", attempt,
        "deletionTokenHash", tokenHash,
        "deletionWorkerRef", workerRef,
        "deletionLeaseExpiresAtMs", tostring(leaseExpiresAt))
      local reply = {
        "claimed",
        redis.call("HGET", artifactKey, "artifactId"),
        redis.call("HGET", artifactKey, "artifactRef"),
        attempt,
        tostring(leaseExpiresAt),
        claimPhase
      }
      for _, value in ipairs(partReply) do reply[#reply + 1] = value end
      return reply
    end
    end
  end
end
return { "empty" }
