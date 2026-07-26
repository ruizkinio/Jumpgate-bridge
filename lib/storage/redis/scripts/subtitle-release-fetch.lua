-- jg-script:subtitle-release-fetch
local globalKeys = subtitle_global_keys(1)
local artifactKeys = subtitle_artifact_keys(10)
local artifactId = ARGV[1]
local artifactRef = ARGV[2]
local tokenHash = ARGV[3]
if #KEYS ~= 12 or #ARGV ~= 3 or not subtitle_valid_digest(tokenHash) then
  return { "state_collision" }
end
local globalOk, globalError = subtitle_ensure_global(globalKeys, false)
if not globalOk then return { globalError == "state_collision" and globalError or "not_found" } end
if subtitle_artifact_schema(artifactKeys.root) ~= "3" or
   redis.call("HGET", artifactKeys.root, "artifactId") ~= artifactId or
   redis.call("HGET", artifactKeys.root, "artifactRef") ~= artifactRef or
   redis.call("HGET", artifactKeys.root, "state") ~= "fetching" or
   redis.call("HGET", artifactKeys.root, "deletionRequested") ~= "0" or
   redis.call("HGET", artifactKeys.root, "fetchTokenHash") ~= tokenHash then
  return { "not_found" }
end
local fetchFence = redis.call("HGET", artifactKeys.root, "fetchFence")
if not subtitle_valid_decimal(fetchFence, 128) or fetchFence == "0" then
  return { "state_collision" }
end
redis.call("ZREM", globalKeys.uploadExpiries, artifactKeys.root)
redis.call("HSET", artifactKeys.root,
  "state", "reserved",
  "fetchFencedTokenHash", tokenHash)
redis.call("HDEL", artifactKeys.root, "fetchTokenHash", "fetchExpiresAtMs")
return { "released", artifactId, fetchFence }
