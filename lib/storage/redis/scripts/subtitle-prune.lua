-- jg-script:subtitle-prune
local globalKeys = subtitle_global_keys(1)
local artifactBatch = tonumber(ARGV[1])
local deletionBatch = tonumber(ARGV[2])
local leaseBatch = tonumber(ARGV[3])
local uploadBatch = tonumber(ARGV[4])
for _, value in ipairs({ artifactBatch, deletionBatch, leaseBatch, uploadBatch }) do
  if not value or value < 1 or value > 256 then return { "state_collision" } end
end
local globalOk, globalError = subtitle_ensure_global(globalKeys, false)
if not globalOk then
  if globalError == "not_found" then return { "pruned", "0", "0", "0", "0", "0" } end
  return { globalError }
end
local now = subtitle_now_ms()
local leases = subtitle_cleanup_global_leases(globalKeys, now, leaseBatch)

local uploads = 0
local dueUploads = redis.call(
  "ZRANGEBYSCORE", globalKeys.uploadExpiries, "-inf", now, "LIMIT", 0, uploadBatch
)
for _, artifactKey in ipairs(dueUploads) do
  local state = redis.call("HGET", artifactKey, "state")
  local handled = false
  if subtitle_artifact_schema(artifactKey) == "3" and state == "fetching" then
    handled = subtitle_reset_expired_fetch(globalKeys, artifactKey, now)
  elseif state == "uploading" then
    local expiresAt = tonumber(redis.call("HGET", artifactKey, "uploadExpiresAtMs"))
    handled = expiresAt and expiresAt <= now and
      subtitle_terminal_abort_upload(globalKeys, artifactKey, now) or false
  end
  if handled then
    uploads = uploads + 1
  else
    redis.call("ZREM", globalKeys.uploadExpiries, artifactKey)
  end
end

local artifacts = 0
local dueArtifacts = redis.call(
  "ZRANGEBYSCORE", globalKeys.artifacts, "-inf", now, "LIMIT", 0, artifactBatch
)
for _, artifactKey in ipairs(dueArtifacts) do
  if subtitle_mark_deleting(globalKeys, artifactKey, now) then artifacts = artifacts + 1
  else redis.call("ZREM", globalKeys.artifacts, artifactKey) end
end

local deletionClaims = 0
local dueClaims = redis.call(
  "ZRANGEBYSCORE", globalKeys.deletionClaims, "-inf", now, "LIMIT", 0, deletionBatch
)
for _, artifactKey in ipairs(dueClaims) do
  if subtitle_requeue_expired_deletion_claim(globalKeys, artifactKey, now) then
    deletionClaims = deletionClaims + 1
  end
end

local hasMore = "0"
if redis.call("ZCOUNT", globalKeys.artifacts, "-inf", now) > 0 or
   redis.call("ZCOUNT", globalKeys.deletions, "-inf", now) > 0 or
   redis.call("ZCOUNT", globalKeys.deletionClaims, "-inf", now) > 0 or
   redis.call("ZCOUNT", globalKeys.leaseExpiries, "-inf", now) > 0 or
   redis.call("ZCOUNT", globalKeys.uploadExpiries, "-inf", now) > 0 then
  hasMore = "1"
end
return {
  "pruned", tostring(artifacts), tostring(deletionClaims),
  tostring(leases), tostring(uploads), hasMore
}
