-- jg-script:subtitle-revalidate
local globalKeys = subtitle_global_keys(1)
local profileKeys = subtitle_profile_keys(10)
local artifactKeys = subtitle_artifact_keys(13)
local playbackKeys = subtitle_playback_keys(16)
local expected = {
  profileTag = ARGV[1], artifactId = ARGV[2], artifactRef = ARGV[3],
  deviceRef = ARGV[4], sessionId = ARGV[5], sessionRef = ARGV[6],
  generation = ARGV[7], contextRef = ARGV[8], contextRevision = ARGV[9],
  providerRevision = ARGV[10]
}
local tokenHash = ARGV[11]
local logicalTtlMs = tonumber(ARGV[12])
local cleanupBatch = tonumber(ARGV[13])
if not logicalTtlMs or logicalTtlMs < 1 or not cleanupBatch or cleanupBatch < 1 or cleanupBatch > 256 then
  return { "state_collision" }
end

local globalOk, globalError = subtitle_ensure_global(globalKeys, false)
if not globalOk then return { globalError == "state_collision" and globalError or "not_found" } end
local now = subtitle_now_ms()
subtitle_cleanup_artifact_leases(globalKeys, artifactKeys, now, cleanupBatch)
local raw = redis.call("HGET", artifactKeys.leaseData, tokenHash)
local directory = raw and subtitle_decode_json(raw) or nil
if not subtitle_valid_lease_directory(directory, directory and directory.member or "") or
   directory.artifactKey ~= artifactKeys.root or tonumber(directory.expiresAtMs) <= now then
  return { "not_found" }
end

local valid = subtitle_artifact_matches(artifactKeys.root, expected) and
  redis.call("HGET", artifactKeys.root, "state") == "committed" and
  redis.call("HGET", artifactKeys.root, "uploadState") == "complete" and
  redis.call("HGET", artifactKeys.root, "deletionRequested") == "0" and
  subtitle_authority_matches(globalKeys, expected.profileTag, expected.generation, expected.providerRevision)
local active = valid and subtitle_active_claim(playbackKeys, expected, now) or nil
if not active then
  subtitle_release_directory(globalKeys, raw, directory)
  if subtitle_artifact_matches(artifactKeys.root, expected) then
    subtitle_mark_deleting(globalKeys, artifactKeys.root, now)
  end
  return { "not_found" }
end
local storedParts = {}
if not subtitle_append_parts(storedParts, artifactKeys.root) then return { "state_collision" } end
local expiresAt = subtitle_refresh_expiry(artifactKeys.root, now, active, logicalTtlMs, globalKeys.artifacts)
if not expiresAt then
  subtitle_release_directory(globalKeys, raw, directory)
  subtitle_mark_deleting(globalKeys, artifactKeys.root, now)
  return { "not_found" }
end
local reply = {
  "revalidated", expected.artifactId, tostring(expiresAt),
  directory.expiresAtMs, directory.method
}
for _, value in ipairs(storedParts) do reply[#reply + 1] = value end
return reply
