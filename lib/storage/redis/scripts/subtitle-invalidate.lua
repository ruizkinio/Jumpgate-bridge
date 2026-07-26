-- jg-script:subtitle-invalidate
local globalKeys = subtitle_global_keys(1)
local profileKeys = subtitle_profile_keys(10)
local profileTag = ARGV[1]
local mode = ARGV[2]
local deviceRef = ARGV[3]
local sessionRef = ARGV[4]
local maximum = tonumber(ARGV[5])
if (mode ~= "release" and mode ~= "session" and mode ~= "device" and mode ~= "profile") or
   not maximum or maximum < 1 or maximum > 64 then return { "state_collision" } end
local globalOk, globalError = subtitle_ensure_global(globalKeys, false)
if not globalOk then
  if globalError == "not_found" then return { "invalidated", "0" } end
  return { globalError }
end
local profileOk, profileError = subtitle_ensure_profile(profileKeys, profileTag, false)
if not profileOk then
  if profileError == "not_found" then return { "invalidated", "0" } end
  return { profileError }
end
if redis.call("ZCARD", profileKeys.artifacts) > maximum then return { "state_collision" } end
local now = subtitle_now_ms()
local invalidated = 0
local artifacts = redis.call("ZRANGE", profileKeys.artifacts, 0, maximum - 1)
for _, artifactKey in ipairs(artifacts) do
  local matches = redis.call("HGET", artifactKey, "profileTag") == profileTag
  if mode == "release" then
    matches = matches and redis.call("HGET", artifactKey, "deviceRef") == deviceRef and
      redis.call("HGET", artifactKey, "sessionRef") == sessionRef
  elseif mode == "device" then
    matches = matches and redis.call("HGET", artifactKey, "deviceRef") == deviceRef
  elseif mode == "session" then
    matches = matches and redis.call("HGET", artifactKey, "sessionRef") == sessionRef
  end
  if matches and subtitle_mark_deleting(globalKeys, artifactKey, now) then
    invalidated = invalidated + 1
  end
end
return { "invalidated", tostring(invalidated) }
