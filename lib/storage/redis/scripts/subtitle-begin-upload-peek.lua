-- jg-script:subtitle-begin-upload-peek
local globalKeys = subtitle_global_keys(1)
local artifactKeys = subtitle_artifact_keys(10)
local playbackKeys = subtitle_playback_keys(13)
local expected = {
  profileTag = ARGV[1], artifactId = ARGV[2], artifactRef = ARGV[3],
  deviceRef = ARGV[4], sessionId = ARGV[5], sessionRef = ARGV[6],
  generation = ARGV[7], contextRef = ARGV[8], contextRevision = ARGV[9],
  providerRevision = ARGV[10]
}
local tokenHash = ARGV[11]
local globalOk, globalError = subtitle_ensure_global(globalKeys, false)
if not globalOk then return { globalError == "state_collision" and globalError or "not_found" } end
if not subtitle_artifact_matches(artifactKeys.root, expected) then return { "not_found" } end
if subtitle_artifact_schema(artifactKeys.root) ~= "2" then return { "not_found" } end

local state = redis.call("HGET", artifactKeys.root, "state")
if state == "uploading" and redis.call("HGET", artifactKeys.root, "uploadState") == "active" then
  if redis.call("HGET", artifactKeys.root, "uploadTokenHash") ~= tokenHash then return { "upload_busy" } end
  local uploadExpiresAt = tonumber(redis.call("HGET", artifactKeys.root, "uploadExpiresAtMs"))
  if not uploadExpiresAt or uploadExpiresAt <= subtitle_now_ms() then return { "not_found" } end
  if redis.call("HGET", artifactKeys.root, "deletionRequested") == "1" then
    local reply = { "aborting", expected.artifactId, tostring(uploadExpiresAt) }
    if not subtitle_append_upload_parts(reply, artifactKeys.root) then return { "state_collision" } end
    return reply
  end
end

if not subtitle_authority_matches(globalKeys, expected.profileTag, expected.generation, expected.providerRevision) then
  return { "not_found" }
end
local now = subtitle_now_ms()
local active = subtitle_active_claim(playbackKeys, expected, now)
if not active then return { "not_found" } end

if state == "reserved" and redis.call("HGET", artifactKeys.root, "deletionRequested") == "0" then
  local envelope = redis.call("HGET", artifactKeys.root, "sourceEnvelope")
  if not envelope then return { "state_collision" } end
  return { "ready", expected.artifactId, redis.call("HGET", artifactKeys.root, "expiresAtMs"), envelope }
end
if state == "uploading" and redis.call("HGET", artifactKeys.root, "uploadState") == "active" then
  local envelope = redis.call("HGET", artifactKeys.root, "sourceEnvelope")
  if not envelope then return { "state_collision" } end
  local reply = {
    "replay", expected.artifactId,
    redis.call("HGET", artifactKeys.root, "expiresAtMs"),
    redis.call("HGET", artifactKeys.root, "uploadExpiresAtMs"),
    envelope
  }
  if not subtitle_append_upload_parts(reply, artifactKeys.root) then return { "state_collision" } end
  return reply
end
if state == "committed" and redis.call("HGET", artifactKeys.root, "deletionRequested") == "0" then
  local reply = { "committed", expected.artifactId, redis.call("HGET", artifactKeys.root, "expiresAtMs") }
  if not subtitle_append_parts(reply, artifactKeys.root) then return { "state_collision" } end
  return reply
end
return { "not_found" }
