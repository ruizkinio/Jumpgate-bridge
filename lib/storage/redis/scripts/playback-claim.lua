-- jg-script:playback-claim-v5
local now = playback_now_ms()
local launchedAtMs = tonumber(ARGV[4])
if not launchedAtMs then return { "too_old" } end
if not playback_valid_identifier(ARGV[18], true) or
   not playback_valid_generation(ARGV[20]) or
   ARGV[21] ~= "5" or
   not playback_valid_device_generation(ARGV[22]) or
   type(ARGV[19]) ~= "string" or #ARGV[19] < 2 or #ARGV[19] > 8192 or
   not playback_valid_digest(ARGV[25], false) or
   not playback_valid_digest(ARGV[26], false) then
  return { "profile_collision" }
end
if launchedAtMs > now + tonumber(ARGV[11]) then return { "future" } end
if now - launchedAtMs > tonumber(ARGV[10]) then return { "too_old" } end

local requestedList = playback_decode_json(ARGV[5])
if not playback_valid_string_array(requestedList, 32, true) or
   #KEYS ~= 23 + #requestedList then return { "profile_collision" } end
for index, _ in ipairs(requestedList) do
  if type(KEYS[19 + index]) ~= "string" or KEYS[19 + index] == "" then
    return { "profile_collision" }
  end
end

local keys = playback_profile_keys(KEYS)
local currentGeneration = playback_current_generation(keys)
if not currentGeneration or currentGeneration ~= ARGV[20] then
  return { "generation_changed" }
end
if playback_pending_generation_deadline(currentGeneration) then return { "snapshot_busy" } end
local attemptKey = KEYS[20 + #requestedList]
local globalAttempts = KEYS[21 + #requestedList]
local profileAttempts = KEYS[22 + #requestedList]
local reconcileIndex = KEYS[23 + #requestedList]
local attempt, attemptError = playback_read_attempt(attemptKey)
if attemptError then return { attemptError } end
if not attempt or attempt.profileTag ~= ARGV[1] or attempt.deviceRef ~= ARGV[2] or
   attempt.intentUrlHash ~= ARGV[3] or attempt.launchedAtMs ~= ARGV[4] or
   attempt.requestDigest ~= ARGV[26] or attempt.sessionId ~= ARGV[6] or
   attempt.generation ~= ARGV[20] or attempt.deviceGeneration ~= ARGV[22] or
   attempt.claimsKey ~= keys.claims or attempt.sessionKey ~= KEYS[19] or
   attempt.rootKey ~= keys.root or attempt.profileAttemptsKey ~= profileAttempts then
  return { "claim_attempt_changed" }
end
if attempt.state == "abandoned" then return { "attempt_abandoned" } end
if attempt.state == "pending" then
  local leaseDeadline = redis.call("HGET", attemptKey, "lease:" .. ARGV[25])
  if not playback_valid_decimal(leaseDeadline, 16) or tonumber(leaseDeadline) <= now then
    return { "attempt_abandoned" }
  end
elseif attempt.state ~= "disclosed" then
  return { "claim_attempt_changed" }
end
local _, ensureError = playback_ensure_profile(keys, ARGV[1], true)
if ensureError then return { ensureError } end
local deviceGenerationMatches, deviceGenerationError =
  playback_device_generation_matches(KEYS[17], ARGV[22], true)
if deviceGenerationError then return { deviceGenerationError } end
if not deviceGenerationMatches then return { "device_generation_changed" } end
local deviceGenerationIndex = KEYS[18]
local deviceGenerationTrackError = playback_track_device_generation(
  deviceGenerationIndex, KEYS[17], now, ARGV[23], ARGV[24]
)
if deviceGenerationTrackError then return { deviceGenerationTrackError } end
local tombstoneTtlMs = tonumber(ARGV[9])
playback_prune_globals(now, keys.globalContexts, keys.globalClaims, keys.globalTombstones, 256)
local purgeError, purgeHasMore = playback_purge_profile(
  keys, now, tombstoneTtlMs, tonumber(ARGV[15]), tonumber(ARGV[16]), tonumber(ARGV[17])
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

local previousRaw = redis.call("HGET", keys.claims, ARGV[2])
local previous = nil
if previousRaw then
  previous = playback_decode_claim(previousRaw)
  if not previous or previous.deviceRef ~= ARGV[2] then return { "profile_collision" } end
end
if previous and previous.intentUrlHash == ARGV[3] and
   previous.launchedAtMs == ARGV[4] then
  if previous.authorityVersion ~= ARGV[21] or
     previous.requestDigest ~= ARGV[26] or
     previous.sessionId ~= ARGV[6] then
    return { "claim_request_conflict" }
  end
  playback_refresh_profile_ttl(keys, now, tombstoneTtlMs)
  if previous.released == "1" then
    local finalizeError = playback_attempt_finalize(
      attemptKey, globalAttempts, profileAttempts, reconcileIndex,
      "not_found", previous.expiresAtMs
    )
    if finalizeError then return { finalizeError } end
    return { "claimed", "not_found", previous.sessionId }
  end
  if previous.status ~= "claimed" then
    local finalizeError = playback_attempt_finalize(
      attemptKey, globalAttempts, profileAttempts, reconcileIndex,
      previous.status, previous.expiresAtMs
    )
    if finalizeError then return { finalizeError } end
    return { "claimed", previous.status, previous.sessionId }
  end
  local contextRaw = redis.call("HGET", keys.contexts, previous.contextRef)
  local context = contextRaw and playback_decode_context_metadata(contextRaw) or nil
  if not context or context.generation ~= currentGeneration then return { "profile_collision" } end
  local finalizeError = playback_attempt_finalize(
    attemptKey, globalAttempts, profileAttempts, reconcileIndex,
    "claimed", previous.expiresAtMs
  )
  if finalizeError then return { finalizeError } end
  local result = {
    "claimed",
    "claimed",
    previous.sessionId,
    contextRaw,
    previous.claimedAtMs,
    previous.expiresAtMs
  }
  table.insert(result, previous.privateStateEnvelope)
  return result
end
if previous and launchedAtMs <= tonumber(previous.launchedAtMs) then
  playback_refresh_profile_ttl(keys, now, tombstoneTtlMs)
  local staleExpiresAtMs = tostring(now + tonumber(ARGV[8]))
  local finalizeError = playback_attempt_finalize(
    attemptKey, globalAttempts, profileAttempts, reconcileIndex,
    "not_found", staleExpiresAtMs
  )
  if finalizeError then return { finalizeError } end
  return { "claimed", "not_found", ARGV[6] }
end
if not previous and (redis.call("ZCARD", keys.globalClaims) >= tonumber(ARGV[13]) or
   redis.call("HLEN", keys.claims) >= tonumber(ARGV[14])) then return { "capacity" } end

local matchingRefs = {}
for index, _ in ipairs(requestedList) do
  local ref = redis.call("GET", KEYS[19 + index])
  if ref then matchingRefs[ref] = true end
end
local matches = {}
for ref, _ in pairs(matchingRefs) do
  local raw = redis.call("HGET", keys.contexts, ref)
  local context = raw and playback_decode_context_metadata(raw) or nil
  if not context or context.ref ~= ref then return { "profile_collision" } end
  local createdAtMs = tonumber(context.createdAtMs)
  local expiresAtMs = tonumber(context.expiresAtMs)
  if context.generation == currentGeneration and expiresAtMs > now and
     createdAtMs <= launchedAtMs + tonumber(ARGV[12]) and
     launchedAtMs - createdAtMs <= tonumber(ARGV[10]) then
    table.insert(matches, { ref = ref, raw = raw, context = context })
  end
end

local status
local stateExpiresAtMs
-- Existing authority consumers recognize v4 private claims. The independent
-- authorityVersion marks the stricter replay schema without weakening them.
local claim = {
  v = "4",
  authorityVersion = ARGV[21],
  deviceRef = ARGV[2],
  intentUrlHash = ARGV[3],
  requestDigest = ARGV[26],
  launchedAtMs = ARGV[4],
  globalMember = ARGV[7],
  released = "0",
  sessionId = ARGV[6]
}
local response = nil
if #matches == 1 then
  local match = matches[1]
  status = "claimed"
  stateExpiresAtMs = tonumber(match.context.expiresAtMs)
  local supersededSessionId = ""
  if previous and previous.released == "0" and previous.status == "claimed" and
     previous.sessionId ~= ARGV[6] then
    supersededSessionId = previous.sessionId
  end
  if supersededSessionId ~= ARGV[18] then
    return {
      "retry", supersededSessionId,
      (previous and (previous.authorityVersion or previous.v)) or "",
      (previous and previous.v == "4" and previous.privateStateEnvelope) or ""
    }
  end
  local stored = redis.call("SET", KEYS[19], keys.root, "NX")
  if not stored then return { "session_collision" } end
  redis.call("PEXPIREAT", KEYS[19], stateExpiresAtMs)
  claim.status = status
  claim.contextRef = match.ref
  claim.sessionKey = KEYS[19]
  claim.claimedAtMs = tostring(now)
  claim.privateStateEnvelope = ARGV[19]
  response = { match.raw, claim.claimedAtMs }
elseif #matches > 1 then
  status = "ambiguous"
  stateExpiresAtMs = 0
  for _, match in ipairs(matches) do
    stateExpiresAtMs = math.max(stateExpiresAtMs, tonumber(match.context.expiresAtMs))
  end
  claim.status = status
else
  local tombstoneExpiry = nil
  for _, hash in ipairs(requestedList) do
    local score = redis.call("ZSCORE", keys.tombstones, hash)
    if score and (not tombstoneExpiry or tonumber(score) > tombstoneExpiry) then
      tombstoneExpiry = tonumber(score)
    end
  end
  if tombstoneExpiry then
    status = "expired"
    stateExpiresAtMs = tombstoneExpiry
  else
    status = "not_found"
    stateExpiresAtMs = now + tonumber(ARGV[8])
  end
  claim.status = status
end

claim.expiresAtMs = tostring(stateExpiresAtMs)
if previous then
  local _, removeError = playback_remove_claim(keys, ARGV[2])
  if removeError then return { removeError } end
end
redis.call("HSET", keys.claims, ARGV[2], cjson.encode(claim))
redis.call("ZADD", keys.claimExpiries, stateExpiresAtMs, ARGV[2])
redis.call("ZADD", keys.globalClaims, stateExpiresAtMs, ARGV[7])
local finalizeError = playback_attempt_finalize(
  attemptKey, globalAttempts, profileAttempts, reconcileIndex,
  status, tostring(stateExpiresAtMs)
)
if finalizeError then return { finalizeError } end
playback_refresh_profile_ttl(keys, now, tombstoneTtlMs)
if status == "claimed" then
  local result = {
    "claimed", status, ARGV[6], response[1], response[2], tostring(stateExpiresAtMs),
  }
  table.insert(result, claim.privateStateEnvelope)
  return result
end
return { "claimed", status, ARGV[6] }
