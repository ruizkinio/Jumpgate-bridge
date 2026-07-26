-- jg-script:subtitle-begin-fetch-peek
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
if #KEYS ~= 17 or #ARGV ~= 11 or not subtitle_valid_digest(tokenHash) then
  return { "state_collision" }
end
local globalOk, globalError = subtitle_ensure_global(globalKeys, false)
if not globalOk then return { globalError == "state_collision" and globalError or "not_found" } end
if not subtitle_artifact_matches(artifactKeys.root, expected) then return { "not_found" } end

local schemaVersion = subtitle_artifact_schema(artifactKeys.root)
local state = redis.call("HGET", artifactKeys.root, "state")
local now = subtitle_now_ms()
local committed = schemaVersion == "3" and state == "committed"
local uploading = schemaVersion == "3" and state == "uploading"
if schemaVersion == "3" and state == "fetching" then
  local activeTokenHash = redis.call("HGET", artifactKeys.root, "fetchTokenHash")
  local fetchExpiresAtRaw = redis.call("HGET", artifactKeys.root, "fetchExpiresAtMs")
  local workScore = redis.call("ZSCORE", globalKeys.uploadExpiries, artifactKeys.root)
  if not subtitle_valid_digest(activeTokenHash) or
     not subtitle_valid_decimal(fetchExpiresAtRaw, 16) or not workScore or
     tonumber(workScore) ~= tonumber(fetchExpiresAtRaw) then return { "state_collision" } end
  if tonumber(fetchExpiresAtRaw) > now then
    if activeTokenHash ~= tokenHash then return { "fetch_busy" } end
    if redis.call("HGET", artifactKeys.root, "deletionRequested") ~= "0" then
      return { "not_found" }
    end
    if not subtitle_authority_matches(
      globalKeys, expected.profileTag, expected.generation, expected.providerRevision
    ) then return { "not_found" } end
    local active = subtitle_active_claim(playbackKeys, expected, now)
    if not active then return { "not_found" } end
    local envelope = redis.call("HGET", artifactKeys.root, "sourceEnvelope")
    if type(envelope) ~= "string" or envelope == "" then return { "state_collision" } end
    return {
      "replay", expected.artifactId,
      redis.call("HGET", artifactKeys.root, "expiresAtMs"),
      fetchExpiresAtRaw,
      redis.call("HGET", artifactKeys.root, "fetchFence"),
      schemaVersion,
      envelope
    }
  end
elseif state ~= "reserved" and not committed and not uploading then
  return { "not_found" }
end

if redis.call("HGET", artifactKeys.root, "deletionRequested") ~= "0" then return { "not_found" } end
if not subtitle_authority_matches(
  globalKeys, expected.profileTag, expected.generation, expected.providerRevision
) then return { "not_found" } end
local active = subtitle_active_claim(playbackKeys, expected, now)
if not active then return { "not_found" } end
if committed then
  local reply = {
    "committed", expected.artifactId,
    redis.call("HGET", artifactKeys.root, "expiresAtMs")
  }
  if not subtitle_append_parts(reply, artifactKeys.root) then return { "state_collision" } end
  return reply
end
if uploading then return { "fetch_busy" } end
local envelope = redis.call("HGET", artifactKeys.root, "sourceEnvelope")
if type(envelope) ~= "string" or envelope == "" then return { "state_collision" } end
return {
  "ready", expected.artifactId,
  redis.call("HGET", artifactKeys.root, "expiresAtMs"),
  schemaVersion,
  envelope
}
