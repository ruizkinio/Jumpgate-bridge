-- jg-script:subtitle-authorize
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
local method = ARGV[11]
local tokenHash = ARGV[12]
local member = ARGV[13]
local leaseTtlMs = tonumber(ARGV[14])
local logicalTtlMs = tonumber(ARGV[15])
local cleanupBatch = tonumber(ARGV[18])

if (method ~= "GET" and method ~= "HEAD") or
   type(tokenHash) ~= "string" or #tokenHash ~= 64 or
   type(member) ~= "string" or #member ~= 64 or
   not leaseTtlMs or leaseTtlMs < 1 or not logicalTtlMs or logicalTtlMs < 1 or
   not cleanupBatch or cleanupBatch < 1 or cleanupBatch > 256 then
  return { "state_collision" }
end
local globalOk, globalError = subtitle_ensure_global(globalKeys, false)
if not globalOk then return { globalError == "state_collision" and globalError or "not_found" } end
local profileOk, profileError = subtitle_ensure_profile(profileKeys, expected.profileTag, false)
if not profileOk then return { profileError == "state_collision" and profileError or "not_found" } end
if not subtitle_artifact_matches(artifactKeys.root, expected) or
   redis.call("HGET", artifactKeys.root, "state") ~= "committed" or
   redis.call("HGET", artifactKeys.root, "uploadState") ~= "complete" or
   redis.call("HGET", artifactKeys.root, "deletionRequested") ~= "0" or
   not subtitle_authority_matches(globalKeys, expected.profileTag, expected.generation, expected.providerRevision) then
  return { "not_found" }
end
local storedParts = {}
if not subtitle_append_parts(storedParts, artifactKeys.root) then return { "state_collision" } end

local now = subtitle_now_ms()
subtitle_cleanup_global_leases(globalKeys, now, cleanupBatch)
subtitle_cleanup_artifact_leases(globalKeys, artifactKeys, now, cleanupBatch)
local active = subtitle_active_claim(playbackKeys, expected, now)
if not active then
  subtitle_mark_deleting(globalKeys, artifactKeys.root, now)
  return { "not_found" }
end
if redis.call("HGET", artifactKeys.leaseData, tokenHash) or redis.call("HGET", globalKeys.leaseData, member) then
  return { "lease_collision" }
end
local profileExceeds = subtitle_would_exceed(profileKeys.root, "leases", "1", ARGV[16])
local globalExceeds = subtitle_would_exceed(globalKeys.root, "leases", "1", ARGV[17])
if profileExceeds == nil or globalExceeds == nil then return { "state_collision" } end
if profileExceeds then return { "profile_lease_capacity" } end
if globalExceeds then return { "global_lease_capacity" } end

local expiresAt = subtitle_refresh_expiry(artifactKeys.root, now, active, logicalTtlMs, globalKeys.artifacts)
if not expiresAt then
  subtitle_mark_deleting(globalKeys, artifactKeys.root, now)
  return { "not_found" }
end
local leaseExpiresAt = subtitle_minimum(expiresAt, active.expiresAtMs, now + leaseTtlMs)
if not leaseExpiresAt or leaseExpiresAt <= now then return { "not_found" } end
local directory = cjson.encode({
  v = "2",
  member = member,
  tokenHash = tokenHash,
  artifactKey = artifactKeys.root,
  artifactLeaseDataKey = artifactKeys.leaseData,
  artifactLeaseExpiriesKey = artifactKeys.leaseExpiries,
  profileRootKey = profileKeys.root,
  method = method,
  expiresAtMs = tostring(leaseExpiresAt)
})
redis.call("HSET", globalKeys.leaseData, member, directory)
redis.call("ZADD", globalKeys.leaseExpiries, leaseExpiresAt, member)
redis.call("HSET", artifactKeys.leaseData, tokenHash, directory)
redis.call("ZADD", artifactKeys.leaseExpiries, leaseExpiresAt, tokenHash)
subtitle_increment_counter(globalKeys.root, "leases", "1")
subtitle_increment_counter(profileKeys.root, "leases", "1")

local reply = { "authorized", expected.artifactId, tostring(expiresAt), tostring(leaseExpiresAt), method }
for _, value in ipairs(storedParts) do reply[#reply + 1] = value end
return reply
