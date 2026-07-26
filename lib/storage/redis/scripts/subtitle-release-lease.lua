-- jg-script:subtitle-release-lease
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
   redis.call("HGET", artifactKeys.root, "artifactRef") ~= artifactRef then
  return { "not_found" }
end
local now = subtitle_now_ms()
subtitle_cleanup_artifact_leases(globalKeys, artifactKeys, now, cleanupBatch)
local raw = redis.call("HGET", artifactKeys.leaseData, tokenHash)
local directory = raw and subtitle_decode_json(raw) or nil
if not subtitle_valid_lease_directory(directory, directory and directory.member or "") or
   directory.artifactKey ~= artifactKeys.root then return { "not_found" } end
if not subtitle_release_directory(globalKeys, raw, directory) then return { "state_collision" } end
return { "released" }
