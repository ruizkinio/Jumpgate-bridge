-- jg-script:playback-prune-v3
local now = playback_now_ms()
local batchSize = tonumber(ARGV[4])
local entryBatchSize = tonumber(ARGV[5])
if not batchSize or batchSize < 1 or batchSize > 256 or batchSize ~= math.floor(batchSize) or
   not entryBatchSize or entryBatchSize < 1 or entryBatchSize > 256 or
   entryBatchSize ~= math.floor(entryBatchSize) then return { "prune_invalid" } end
playback_prune_globals(now, KEYS[1], KEYS[2], KEYS[3], batchSize)
local dueProfiles = redis.call(
  "ZRANGEBYSCORE", KEYS[4], "-inf", now, "LIMIT", 0, batchSize
)
for _, rootKey in ipairs(dueProfiles) do
  local keys = playback_load_scheduled_profile(rootKey, KEYS[1], KEYS[2], KEYS[3], KEYS[4])
  if not keys then
    redis.call("ZREM", KEYS[4], rootKey)
  else
    local purgeError, purgeHasMore = playback_purge_profile(
      keys, now, tonumber(ARGV[1]), tonumber(ARGV[2]), tonumber(ARGV[3]), entryBatchSize
    )
    if purgeError then
      if purgeHasMore then
        playback_refresh_profile_ttl(keys, now, tonumber(ARGV[1]), true)
      else
        redis.call("ZREM", KEYS[4], rootKey)
      end
    else
      playback_refresh_profile_ttl(keys, now, tonumber(ARGV[1]), purgeHasMore)
    end
  end
end
playback_prune_globals(now, KEYS[1], KEYS[2], KEYS[3], batchSize)
return {
  "pruned",
  tostring(redis.call("ZCARD", KEYS[1])),
  tostring(redis.call("ZCARD", KEYS[2])),
  tostring(redis.call("ZCARD", KEYS[3])),
  (redis.call("ZCOUNT", KEYS[4], "-inf", now) > 0 or
   playback_has_due_globals(now, KEYS[1], KEYS[2], KEYS[3])) and "1" or "0"
}
