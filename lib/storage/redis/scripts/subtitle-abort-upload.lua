-- jg-script:subtitle-abort-upload
local globalKeys = subtitle_global_keys(1)
local artifactKeys = subtitle_artifact_keys(10)
local artifactId = ARGV[1]
local artifactRef = ARGV[2]
local tokenHash = ARGV[3]
local globalOk, globalError = subtitle_ensure_global(globalKeys, false)
if not globalOk then return { globalError == "state_collision" and globalError or "not_found" } end
if not subtitle_artifact_schema(artifactKeys.root) or
   redis.call("HGET", artifactKeys.root, "artifactId") ~= artifactId or
   redis.call("HGET", artifactKeys.root, "artifactRef") ~= artifactRef or
   redis.call("HGET", artifactKeys.root, "uploadTokenHash") ~= tokenHash then
  return { "not_found" }
end

local state = redis.call("HGET", artifactKeys.root, "state")
local uploadState = redis.call("HGET", artifactKeys.root, "uploadState")
if state == "committed" and uploadState == "complete" then return { "complete" } end
if state == "uploading" and uploadState == "active" then
  if not subtitle_terminal_abort_upload(globalKeys, artifactKeys.root, subtitle_now_ms()) then
    return { "state_collision" }
  end
elseif state ~= "deleting" or uploadState ~= "aborted" then
  return { "not_found" }
end
local reply = { "aborted", artifactId }
if not subtitle_append_parts(reply, artifactKeys.root) then return { "state_collision" } end
return reply
