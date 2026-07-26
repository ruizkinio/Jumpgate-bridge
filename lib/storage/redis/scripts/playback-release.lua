-- jg-script:playback-release-v4
local now = playback_now_ms()
if #KEYS ~= 17 or not playback_valid_generation(ARGV[8]) or
   not playback_valid_identifier(ARGV[9], true) then
  return { "profile_collision" }
end
local keys = playback_profile_keys(KEYS)
local currentGeneration = playback_current_generation(keys)
if not currentGeneration or currentGeneration ~= ARGV[8] or
   playback_pending_generation_deadline(currentGeneration) then
  return { "generation_changed" }
end
local profileExists, profileError = playback_ensure_profile(keys, ARGV[1], false)
if profileError == "not_found" or not profileExists then return { "not_found" } end
if profileError then return { profileError } end
local tombstoneTtlMs = tonumber(ARGV[4])
playback_prune_globals(now, keys.globalContexts, keys.globalClaims, keys.globalTombstones, 256)
local purgeError, purgeHasMore = playback_purge_profile(
  keys, now, tombstoneTtlMs, tonumber(ARGV[5]), tonumber(ARGV[6]), tonumber(ARGV[7])
)
if purgeError then
  if purgeHasMore then playback_refresh_profile_ttl(keys, now, tombstoneTtlMs, true) end
  return { purgeError }
end
if purgeHasMore then
  playback_refresh_profile_ttl(keys, now, tombstoneTtlMs, true)
  return { "prune_pending" }
end
if playback_has_due_globals(
  now, keys.globalContexts, keys.globalClaims, keys.globalTombstones
) then
  playback_refresh_profile_ttl(keys, now, tombstoneTtlMs, false)
  return { "prune_pending" }
end
local raw = redis.call("HGET", keys.claims, ARGV[2])
local claim = raw and playback_decode_claim(raw) or nil
if raw and not claim then return { "profile_collision" } end
if not claim or claim.released ~= "0" or claim.status ~= "claimed" or
   claim.sessionId ~= ARGV[3] or claim.sessionKey ~= KEYS[17] or
   (ARGV[9] ~= "" and (claim.v ~= "4" or claim.cleanupOwner ~= ARGV[9])) then
  playback_refresh_profile_ttl(keys, now, tombstoneTtlMs)
  return { "not_found" }
end
claim.released = "1"
redis.call("HSET", keys.claims, ARGV[2], cjson.encode(claim))
playback_refresh_profile_ttl(keys, now, tombstoneTtlMs)
return { "released" }
