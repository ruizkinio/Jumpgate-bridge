-- jg-script:playback-get-or-initialize-generation-v1
if #KEYS ~= 1 or #ARGV ~= 1 or not playback_valid_generation(ARGV[1]) or
   playback_pending_generation_deadline(ARGV[1]) then
  return { "profile_collision" }
end

local keyType = playback_key_type(KEYS[1])
if keyType ~= "none" and keyType ~= "string" then return { "profile_collision" } end
if keyType == "none" then redis.call("SET", KEYS[1], ARGV[1], "NX") end

local generation = redis.call("GET", KEYS[1])
if not playback_valid_generation(generation) then return { "profile_collision" } end
return { "generation", generation }
