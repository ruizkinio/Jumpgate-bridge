-- jg-script:playback-invalidate-device-v4
local now = playback_now_ms()
if #KEYS ~= 18 or not playback_valid_generation(ARGV[8]) then
  return { "profile_collision" }
end
local keys = playback_profile_keys(KEYS)
local currentGeneration = playback_current_generation(keys)
if not currentGeneration or currentGeneration ~= ARGV[8] then
  return { "generation_changed" }
end
if playback_pending_generation_deadline(currentGeneration) then return { "generation_changed" } end
local _, deviceGenerationError = playback_advance_device_generation(KEYS[17], ARGV[9])
if deviceGenerationError then return { deviceGenerationError } end
local deviceGenerationTrackError = playback_track_device_generation(
  KEYS[18], KEYS[17], now, ARGV[10], ARGV[11]
)
if deviceGenerationTrackError then return { deviceGenerationTrackError } end
local profileExists, profileError = playback_ensure_profile(keys, ARGV[1], false)
if profileError == "not_found" or not profileExists then return { "invalidated", "0" } end
if profileError then return { profileError } end

local tombstoneTtlMs = tonumber(ARGV[3])
playback_prune_globals(now, keys.globalContexts, keys.globalClaims, keys.globalTombstones, 256)
local purgeError, purgeHasMore = playback_purge_profile(
  keys, now, tombstoneTtlMs, tonumber(ARGV[4]), tonumber(ARGV[5]), tonumber(ARGV[6])
)
if purgeError then
  if purgeHasMore then playback_refresh_profile_ttl(keys, now, tombstoneTtlMs, true) end
  return { purgeError }
end
if purgeHasMore or playback_has_due_globals(
  now, keys.globalContexts, keys.globalClaims, keys.globalTombstones
) then
  playback_refresh_profile_ttl(keys, now, tombstoneTtlMs, purgeHasMore)
  return { "prune_pending" }
end

local raw = redis.call("HGET", keys.claims, ARGV[2])
local claim = raw and playback_decode_claim(raw) or nil
if raw and not claim then return { "profile_collision" } end
if not claim then
  playback_refresh_profile_ttl(keys, now, tombstoneTtlMs)
  return { "invalidated", "0" }
end
if claim.status == "claimed" and claim.sessionKey then redis.call("DEL", claim.sessionKey) end
local _, claimError = playback_remove_claim(keys, ARGV[2])
if claimError then return { claimError } end
playback_refresh_profile_ttl(keys, now, tombstoneTtlMs)
return { "invalidated", "1" }
