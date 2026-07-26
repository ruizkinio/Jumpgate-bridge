-- jg-script:playback-invalidate-v4
if #KEYS ~= 16 or not playback_valid_generation(ARGV[2]) or
   not playback_valid_generation(ARGV[3]) then
  return { "profile_collision" }
end
local keys = playback_profile_keys(KEYS)
local currentGeneration = playback_current_generation(keys)
if not currentGeneration or currentGeneration ~= ARGV[2] then
  return { "generation_changed" }
end
if currentGeneration == ARGV[3] then return { "generation_collision" } end
local profileExists, profileError = playback_ensure_profile(keys, ARGV[1], false)
if profileError ~= "not_found" and profileError then return { profileError } end
if profileExists then
  for _, ref in ipairs(redis.call("HKEYS", keys.contexts)) do
    local _, contextError = playback_remove_context(keys, ref)
    if contextError then return { contextError } end
  end
  for _, deviceRef in ipairs(redis.call("HKEYS", keys.claims)) do
    local raw = redis.call("HGET", keys.claims, deviceRef)
    local claim = raw and playback_decode_claim(raw) or nil
    if raw and not claim then return { "profile_collision" } end
    if claim and claim.status == "claimed" and claim.sessionKey then
      redis.call("DEL", claim.sessionKey)
    end
    local _, claimError = playback_remove_claim(keys, deviceRef)
    if claimError then return { claimError } end
  end
  for _, hash in ipairs(redis.call("ZRANGE", keys.tombstones, 0, -1)) do
    playback_remove_tombstone(keys, hash)
  end
end
playback_delete_profile(keys)
redis.call("SET", keys.generation, ARGV[3])
return { "invalidated", ARGV[3] }
