-- jg-script:playback-record-v7
local function playback_snapshot_load(stateKey, expectedProfileTag)
  local stateType = playback_key_type(stateKey)
  if stateType == "none" then return nil, nil end
  if stateType ~= "hash" or redis.call("HLEN", stateKey) ~= 6 then
    return nil, "profile_collision"
  end
  local state = {
    schemaVersion = redis.call("HGET", stateKey, "schemaVersion"),
    profileTag = redis.call("HGET", stateKey, "profileTag"),
    token = redis.call("HGET", stateKey, "token"),
    phase = redis.call("HGET", stateKey, "phase"),
    expiresAtMs = redis.call("HGET", stateKey, "expiresAtMs"),
    fence = redis.call("HGET", stateKey, "fence")
  }
  if state.schemaVersion ~= "1" or state.profileTag ~= expectedProfileTag or
     not playback_pending_generation_deadline(state.token) or
     (state.phase ~= "leased" and state.phase ~= "fenced" and state.phase ~= "recovering") or
     not playback_valid_decimal(state.expiresAtMs, 16) or
     not playback_valid_decimal(state.fence, 128) then
    return nil, "profile_collision"
  end
  return state, nil
end

local function playback_snapshot_clear_profile(keys, expectedProfileTag, deviceGenerationIndex)
  local profileExists, profileError = playback_ensure_profile(keys, expectedProfileTag, false)
  if profileError ~= "not_found" and profileError then return profileError end
  if profileExists then
    for _, ref in ipairs(redis.call("HKEYS", keys.contexts)) do
      local _, contextError = playback_remove_context(keys, ref)
      if contextError then return contextError end
    end
    for _, deviceRef in ipairs(redis.call("HKEYS", keys.claims)) do
      local raw = redis.call("HGET", keys.claims, deviceRef)
      local claim = raw and playback_decode_claim(raw) or nil
      if raw and not claim then return "profile_collision" end
      if claim and claim.status == "claimed" and claim.sessionKey then
        redis.call("DEL", claim.sessionKey)
      end
      local _, claimError = playback_remove_claim(keys, deviceRef)
      if claimError then return claimError end
    end
    for _, hash in ipairs(redis.call("ZRANGE", keys.tombstones, 0, -1)) do
      playback_remove_tombstone(keys, hash)
    end
  end
  local generationError = playback_delete_device_generations(deviceGenerationIndex)
  if generationError then return generationError end
  playback_delete_profile(keys)
  return nil
end

local snapshotMode = ARGV[3]
if snapshotMode == "snapshot_state" or snapshotMode == "snapshot_begin" or
   snapshotMode == "snapshot_renew" or snapshotMode == "snapshot_fence" or
   snapshotMode == "snapshot_release" or snapshotMode == "snapshot_complete" or
   snapshotMode == "snapshot_recover_probe" or snapshotMode == "snapshot_recover_begin" or
   snapshotMode == "snapshot_recover_complete" or
   snapshotMode == "snapshot_invalidate" then
  if #KEYS ~= 19 then return { "profile_collision" } end
  local snapshotKeys = playback_profile_keys(KEYS)
  local mutationStateKey = KEYS[17]
  local fenceCounterKey = KEYS[18]
  local deviceGenerationIndex = KEYS[19]
  local currentGeneration = playback_current_generation(snapshotKeys)
  if not currentGeneration then return { "snapshot_changed", "" } end
  local state, stateError = playback_snapshot_load(mutationStateKey, ARGV[1])
  if stateError then return { stateError } end
  local now = playback_now_ms()

  if snapshotMode == "snapshot_state" then
    if not playback_valid_generation(ARGV[2]) or
       playback_pending_generation_deadline(ARGV[2]) then return { "profile_collision" } end
    local currentDeadline = playback_pending_generation_deadline(currentGeneration)
    if not currentDeadline then
      if state then redis.call("DEL", mutationStateKey) end
      return { "snapshot_state", currentGeneration, "0" }
    end
    if state then
      if state.token ~= currentGeneration then return { "profile_collision" } end
      if state.phase == "fenced" or state.phase == "recovering" or
         tonumber(state.expiresAtMs) > now then
        return { "snapshot_state", currentGeneration, "1" }
      end
    elseif currentDeadline > now then
      return { "snapshot_state", currentGeneration, "1" }
    end
    redis.call("SET", snapshotKeys.generation, ARGV[2])
    redis.call("DEL", mutationStateKey)
    return { "snapshot_state", ARGV[2], "0" }
  end

  if snapshotMode == "snapshot_begin" then
    local deadline = playback_pending_generation_deadline(ARGV[2])
    if not deadline or deadline <= now or not playback_valid_decimal(ARGV[5], 16) or
       tonumber(ARGV[5]) ~= deadline then
      return { "profile_collision" }
    end
    if currentGeneration ~= ARGV[4] then return { "snapshot_changed", currentGeneration } end
    if playback_pending_generation_deadline(currentGeneration) then
      return { "snapshot_busy", currentGeneration }
    end
    if state then redis.call("DEL", mutationStateKey) end
    local clearError = playback_snapshot_clear_profile(
      snapshotKeys, ARGV[1], deviceGenerationIndex
    )
    if clearError then return { clearError } end
    redis.call("SET", snapshotKeys.generation, ARGV[2])
    redis.call(
      "HSET", mutationStateKey,
      "schemaVersion", "1",
      "profileTag", ARGV[1],
      "token", ARGV[2],
      "phase", "leased",
      "expiresAtMs", ARGV[5],
      "fence", "0"
    )
    return { "snapshot_begun", ARGV[2], "0" }
  end

  if snapshotMode == "snapshot_invalidate" then
    if not playback_valid_generation(ARGV[2]) or playback_pending_generation_deadline(ARGV[2]) or
       not playback_valid_generation(ARGV[4]) or playback_pending_generation_deadline(ARGV[4]) then
      return { "profile_collision" }
    end
    if playback_pending_generation_deadline(currentGeneration) or state then
      return { "snapshot_busy", currentGeneration }
    end
    if currentGeneration ~= ARGV[4] then return { "snapshot_changed", currentGeneration } end
    local clearError = playback_snapshot_clear_profile(
      snapshotKeys, ARGV[1], deviceGenerationIndex
    )
    if clearError then return { clearError } end
    redis.call("SET", snapshotKeys.generation, ARGV[2])
    return { "invalidated", ARGV[2] }
  end

  local expectedGeneration = ARGV[4]
  if not playback_pending_generation_deadline(expectedGeneration) then
    return { "profile_collision" }
  end
  if currentGeneration ~= expectedGeneration or not state or state.token ~= expectedGeneration then
    return { "snapshot_changed", currentGeneration }
  end

  if snapshotMode == "snapshot_recover_probe" then
    if state.phase == "recovering" or
       (state.phase == "fenced" and tonumber(state.expiresAtMs) <= now) then
      return { "snapshot_recovery_ready", state.token, state.fence, state.phase }
    end
    return { "snapshot_recovery_unavailable", currentGeneration }
  end

  if snapshotMode == "snapshot_recover_begin" then
    if not playback_valid_decimal(ARGV[5], 128) then return { "profile_collision" } end
    local expectedRecoveryFence = ARGV[6]
    if expectedRecoveryFence ~= "" and
       not playback_valid_decimal(expectedRecoveryFence, 128) then
      return { "profile_collision" }
    end
    if state.phase ~= "recovering" and
       (state.phase ~= "fenced" or tonumber(state.expiresAtMs) > now) then
      return { "snapshot_recovery_unavailable", currentGeneration }
    end
    local counterType = playback_key_type(fenceCounterKey)
    if counterType ~= "none" and counterType ~= "string" then return { "profile_collision" } end
    local currentFence = redis.call("GET", fenceCounterKey) or state.fence
    if not playback_valid_decimal(currentFence, 128) or
       playback_decimal_compare(currentFence, state.fence) < 0 then
      return { "profile_collision" }
    end
    if state.phase == "recovering" then
      if expectedRecoveryFence == "" or state.fence ~= expectedRecoveryFence then
        return { "snapshot_recovery_begun", state.token, state.fence }
      end
    elseif expectedRecoveryFence ~= "" and state.fence ~= expectedRecoveryFence then
      return { "snapshot_recovery_begun", state.token, state.fence }
    end
    local recoveryFence = playback_decimal_increment(currentFence)
    if not recoveryFence then return { "profile_collision" } end
    if playback_decimal_compare(ARGV[5], recoveryFence) > 0 then recoveryFence = ARGV[5] end
    redis.call("SET", fenceCounterKey, recoveryFence)
    redis.call("HSET", mutationStateKey, "phase", "recovering", "fence", recoveryFence)
    return { "snapshot_recovery_begun", state.token, recoveryFence }
  end

  if snapshotMode == "snapshot_renew" then
    local renewedUntil = tonumber(ARGV[5])
    if state.phase ~= "leased" or tonumber(state.expiresAtMs) <= now or
       not renewedUntil or renewedUntil <= now then
      return { "snapshot_changed", currentGeneration }
    end
    if renewedUntil > tonumber(state.expiresAtMs) then
      redis.call("HSET", mutationStateKey, "expiresAtMs", ARGV[5])
    else
      renewedUntil = tonumber(state.expiresAtMs)
    end
    return { "snapshot_renewed", tostring(renewedUntil), state.fence }
  end

  if snapshotMode == "snapshot_fence" then
    if not playback_valid_decimal(ARGV[5], 128) then return { "profile_collision" } end
    if state.phase == "fenced" then
      if state.fence ~= ARGV[5] then return { "snapshot_changed", currentGeneration } end
      return { "snapshot_fenced", state.fence }
    end
    if state.phase ~= "leased" or tonumber(state.expiresAtMs) <= now then
      return { "snapshot_changed", currentGeneration }
    end
    local counterType = playback_key_type(fenceCounterKey)
    if counterType ~= "none" and counterType ~= "string" then return { "profile_collision" } end
    local currentFence = redis.call("GET", fenceCounterKey)
    if currentFence and not playback_valid_decimal(currentFence, 128) then
      return { "profile_collision" }
    end
    if not currentFence or playback_decimal_compare(ARGV[5], currentFence) > 0 then
      redis.call("SET", fenceCounterKey, ARGV[5])
    end
    -- The supplied token was allocated by durable storage. Redis only binds
    -- that token to the active lease and mirrors its high-water mark.
    redis.call("HSET", mutationStateKey, "phase", "fenced", "fence", ARGV[5])
    return { "snapshot_fenced", ARGV[5] }
  end

  if not playback_valid_generation(ARGV[2]) or
     playback_pending_generation_deadline(ARGV[2]) then return { "profile_collision" } end

  if snapshotMode == "snapshot_release" then
    if state.phase ~= "leased" or tonumber(state.expiresAtMs) <= now then
      return { "snapshot_changed", currentGeneration }
    end
    redis.call("SET", snapshotKeys.generation, ARGV[2])
    redis.call("DEL", mutationStateKey)
    return { "snapshot_released", ARGV[2] }
  end

  if snapshotMode == "snapshot_complete" then
    if state.phase == "recovering" then return { "snapshot_changed", currentGeneration } end
    if state.phase ~= "fenced" then return { "snapshot_unfenced", currentGeneration } end
    redis.call("SET", snapshotKeys.generation, ARGV[2])
    redis.call("DEL", mutationStateKey)
    return { "snapshot_completed", ARGV[2] }
  end

  if snapshotMode == "snapshot_recover_complete" then
    if state.phase ~= "recovering" or not playback_valid_decimal(ARGV[5], 128) or
       state.fence ~= ARGV[5] then
      return { "snapshot_changed", currentGeneration }
    end
    redis.call("SET", snapshotKeys.generation, ARGV[2])
    redis.call("DEL", mutationStateKey)
    return { "snapshot_recovery_completed", ARGV[2] }
  end

  return { "profile_collision" }
end

local now = playback_now_ms()
local candidateRaw = ARGV[4]
local candidate = playback_decode_context_metadata(candidateRaw)
if not candidate or candidate.generation ~= ARGV[2] then return { "metadata_invalid" } end
if #KEYS ~= 16 + #candidate.fingerprintIndexKeys then return { "metadata_invalid" } end
for index, key in ipairs(candidate.fingerprintIndexKeys) do
  if key ~= KEYS[16 + index] then return { "metadata_invalid" } end
end
if ARGV[3] ~= "insert" and ARGV[3] ~= "update" then return { "metadata_invalid" } end

local ttlMs = tonumber(ARGV[6])
local tombstoneTtlMs = tonumber(ARGV[7])
local maxContexts = tonumber(ARGV[8])
local maxContextsPerProfile = tonumber(ARGV[9])
local maxTombstones = tonumber(ARGV[10])
local maxTombstonesPerProfile = tonumber(ARGV[11])
local pruneEntryBatchSize = tonumber(ARGV[12])
if not ttlMs or not tombstoneTtlMs or not maxContexts or not maxContextsPerProfile or
   not maxTombstones or not maxTombstonesPerProfile or not pruneEntryBatchSize then
  return { "metadata_invalid" }
end

local keys = playback_profile_keys(KEYS)
if playback_pending_generation_deadline(ARGV[2]) then return { "snapshot_busy" } end
if playback_current_generation(keys) ~= ARGV[2] then return { "generation_changed" } end
local profileExists, profileError = playback_ensure_profile(keys, ARGV[1], false)
if profileError ~= "not_found" and profileError then return { profileError } end
playback_prune_globals(now, keys.globalContexts, keys.globalClaims, keys.globalTombstones, 256)
if profileExists then
  local purgeError, purgeHasMore = playback_purge_profile(
    keys, now, tombstoneTtlMs, maxTombstones, maxTombstonesPerProfile, pruneEntryBatchSize
  )
  if purgeError then
    if purgeHasMore then playback_refresh_profile_ttl(keys, now, tombstoneTtlMs, true) end
    return { purgeError }
  end
  if purgeHasMore then
    playback_refresh_profile_ttl(keys, now, tombstoneTtlMs, true)
    return { "prune_pending" }
  end
end
if playback_has_due_globals(
  now, keys.globalContexts, keys.globalClaims, keys.globalTombstones
) then
  if profileExists then playback_refresh_profile_ttl(keys, now, tombstoneTtlMs, false) end
  return { "prune_pending" }
end

local equivalentRef = nil
local equivalentRaw = nil
if candidate.equivalenceHash ~= "" and profileExists then
  equivalentRef = redis.call("HGET", keys.equivalences, candidate.equivalenceHash)
  if equivalentRef then
    equivalentRaw = redis.call("HGET", keys.contexts, equivalentRef)
    if not equivalentRaw then
      redis.call("HDEL", keys.equivalences, candidate.equivalenceHash)
      equivalentRef = nil
    end
  end
end

if ARGV[3] == "insert" then
  if equivalentRaw then return { "existing", equivalentRaw } end
  for _, indexKey in ipairs(candidate.fingerprintIndexKeys) do
    if redis.call("GET", indexKey) then return { "overlap" } end
  end
  if redis.call("ZCARD", keys.globalContexts) >= maxContexts or
     redis.call("HLEN", keys.contexts) >= maxContextsPerProfile then return { "capacity" } end
  if redis.call("HEXISTS", keys.contexts, candidate.ref) == 1 then return { "id_collision" } end
else
  local currentRaw = redis.call("HGET", keys.contexts, candidate.ref)
  if not currentRaw or currentRaw ~= ARGV[5] or equivalentRef ~= candidate.ref then
    if equivalentRaw then return { "changed", equivalentRaw } end
    return { "profile_collision" }
  end
  local existing = playback_decode_context_metadata(currentRaw)
  local providerComparison = nil
  if existing and existing.v == "4" and candidate.v == "4" then
    providerComparison = playback_decimal_compare(candidate.providerRevision, existing.providerRevision)
  elseif existing and existing.v == "3" then
    providerComparison = 0
  end
  if not existing or existing.generation ~= candidate.generation or
     existing.equivalenceHash ~= candidate.equivalenceHash or
     playback_decimal_increment(existing.revision) ~= candidate.revision or
     providerComparison == nil or providerComparison < 0 or
     #existing.fingerprintIndexKeys ~= #candidate.fingerprintIndexKeys then
    return { "metadata_invalid" }
  end
  local expectedIndexes = {}
  for _, indexKey in ipairs(existing.fingerprintIndexKeys) do expectedIndexes[indexKey] = true end
  for _, indexKey in ipairs(candidate.fingerprintIndexKeys) do
    if not expectedIndexes[indexKey] then return { "metadata_invalid" } end
    local owner = redis.call("GET", indexKey)
    if owner and owner ~= candidate.ref then return { "overlap" } end
  end
end

local _, ensureError = playback_ensure_profile(keys, ARGV[1], true)
if ensureError then return { ensureError } end
if playback_current_generation(keys) ~= ARGV[2] then return { "generation_changed" } end
candidateRaw = cjson.encode(candidate)
redis.call("HSET", keys.contexts, candidate.ref, candidateRaw)
redis.call("ZADD", keys.contextExpiries, candidate.expiresAtMs, candidate.ref)
if candidate.equivalenceHash ~= "" then
  redis.call("HSET", keys.equivalences, candidate.equivalenceHash, candidate.ref)
end
redis.call("ZADD", keys.globalContexts, candidate.expiresAtMs, candidate.globalMember)
for _, indexKey in ipairs(candidate.fingerprintIndexKeys) do
  redis.call("SET", indexKey, candidate.ref)
  redis.call("PEXPIREAT", indexKey, candidate.expiresAtMs)
end
playback_refresh_profile_ttl(keys, now, tombstoneTtlMs)
return { "recorded" }
