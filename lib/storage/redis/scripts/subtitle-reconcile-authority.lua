-- jg-script:subtitle-reconcile-authority
local globalKeys = subtitle_global_keys(1)
local profileKeys = subtitle_profile_keys(10)
local playbackGenerationKey = KEYS[13]
local profileTag = ARGV[1]
local providerRevision = ARGV[2]
local generation = ARGV[3]
local maxAuthorities = ARGV[4]
local maxProfileArtifacts = tonumber(ARGV[5])

if #KEYS ~= 13 or #ARGV ~= 5 or type(profileTag) ~= "string" or #profileTag ~= 64 or
   string.match(profileTag, "^[a-f0-9]+$") == nil or
   not subtitle_valid_decimal(providerRevision, 128) or
   not subtitle_valid_generation(generation) or
   not subtitle_valid_decimal(maxAuthorities, 128) or
   not maxProfileArtifacts or maxProfileArtifacts < 1 or maxProfileArtifacts > 64 then
  return { "state_collision" }
end

local generationKeyType = subtitle_key_type(playbackGenerationKey)
if generationKeyType == "none" then return { "authority_stale" } end
if generationKeyType ~= "string" then
  return { "state_collision" }
end
local liveGeneration = redis.call("GET", playbackGenerationKey)
if not subtitle_valid_generation(liveGeneration) or liveGeneration ~= generation then
  return { "authority_stale" }
end

local globalState = subtitle_authority_store_preflight(globalKeys)
if not globalState then return { "state_collision" } end

local raw = redis.call("HGET", globalKeys.authorities, profileTag)
local current = raw and subtitle_decode_json(raw) or nil
local revision
local creating = false
local unchanged = false
if not raw then
  local exceeds = subtitle_would_exceed(globalKeys.root, "authorities", "1", maxAuthorities)
  if exceeds == nil then return { "state_collision" } end
  if exceeds then return { "global_capacity" } end
  revision = "1"
  creating = true
else
  if not current or current.v ~= "1" or current.profileTag ~= profileTag or
     not subtitle_valid_decimal(current.providerRevision, 128) or
     not subtitle_valid_generation(current.generation) or
     not subtitle_valid_decimal(current.revision, 128) then
    return { "state_collision" }
  end
  if current.providerRevision == providerRevision and current.generation == generation then
    revision = current.revision
    unchanged = true
  else
    local providerComparison = subtitle_decimal_compare(providerRevision, current.providerRevision)
    if providerComparison == nil then return { "state_collision" } end
    if providerComparison < 0 then return { "authority_stale" } end
    revision = subtitle_decimal_add(current.revision, "1")
    if not revision then return { "state_collision" } end
  end
end

local nextAuthority = {
  v = "1",
  profileTag = profileTag,
  providerRevision = providerRevision,
  generation = generation,
  revision = revision
}
local artifacts = subtitle_authority_artifacts_preflight(
  globalKeys, profileKeys, profileTag, current, nextAuthority, maxProfileArtifacts, globalState
)
if not artifacts then return { "state_collision" } end
if unchanged then return { "unchanged", revision, "0" } end
local encodedAuthority = cjson.encode(nextAuthority)

if #artifacts > 0 then
  local now = subtitle_now_ms()
  for index, artifact in ipairs(artifacts) do
    if not subtitle_mark_deleting(globalKeys, artifact.key, now, true) then
      for rollbackIndex = index - 1, 1, -1 do
        subtitle_restore_authority_artifact(globalKeys, profileKeys, artifacts[rollbackIndex])
      end
      error("subtitle authority invalidation invariant")
    end
  end
  for _, artifact in ipairs(artifacts) do redis.call("HDEL", artifact.key, "sourceEnvelope") end
end


if globalState == "missing" then
  local globalOk = subtitle_ensure_global(globalKeys, true)
  if not globalOk then error("subtitle authority global creation invariant") end
end
if creating and not subtitle_increment_counter(globalKeys.root, "authorities", "1") then
  error("subtitle authority counter invariant")
end
redis.call("HSET", globalKeys.authorities, profileTag, encodedAuthority)

return { "updated", revision, tostring(#artifacts) }
