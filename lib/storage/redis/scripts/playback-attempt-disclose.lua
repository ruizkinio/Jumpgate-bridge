-- jg-script:playback-attempt-disclose-v1
local now = playback_now_ms()
if #KEYS ~= 4 or not playback_valid_digest(ARGV[1], false) or
   not playback_valid_digest(ARGV[2], false) or
   not playback_valid_identifier(ARGV[3], false) or
   not playback_valid_digest(ARGV[4], false) then return { "profile_collision" } end
local attemptKey = redis.call("GET", KEYS[1])
if not attemptKey then return { "not_found" } end
local record, recordError = playback_read_attempt(attemptKey)
if recordError then return { recordError } end
if not record or record.profileTag ~= ARGV[1] or record.deviceRef ~= ARGV[2] or
   record.sessionId ~= ARGV[3] or record.pointerKey ~= KEYS[1] then
  return { "profile_collision" }
end
if playback_key_type(KEYS[3]) ~= "string" or
   redis.call("GET", KEYS[3]) ~= record.generation then return { "generation_changed" } end
if playback_key_type(KEYS[4]) ~= "string" or
   redis.call("GET", KEYS[4]) ~= record.deviceGeneration then
  return { "device_generation_changed" }
end
if record.state == "disclosed" then return { "disclosed" } end
if record.state ~= "pending" or record.resultStatus ~= "claimed" then return { "not_found" } end
local deadline = redis.call("HGET", attemptKey, "lease:" .. ARGV[4])
if not playback_valid_decimal(deadline, 16) or tonumber(deadline) <= now then
  return { "not_found" }
end
record.state = "disclosed"
playback_attempt_clear_leases(attemptKey)
redis.call("HSET", attemptKey, "record", cjson.encode(record))
redis.call("ZREM", KEYS[2], attemptKey)
return { "disclosed" }
