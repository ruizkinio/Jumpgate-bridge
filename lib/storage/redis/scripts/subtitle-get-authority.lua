-- jg-script:subtitle-get-authority
if #KEYS ~= 9 or #ARGV ~= 1 or type(ARGV[1]) ~= "string" or #ARGV[1] ~= 64 then
  return { "state_collision" }
end

local globalKeys = subtitle_global_keys(1)
local globalOk, globalError = subtitle_ensure_global(globalKeys, false)
if not globalOk then
  if globalError == "not_found" then return { "not_found" } end
  return { globalError }
end

local raw = redis.call("HGET", globalKeys.authorities, ARGV[1])
if not raw then return { "not_found" } end
local current = subtitle_decode_json(raw)
if not current or current.v ~= "1" or current.profileTag ~= ARGV[1] or
   not subtitle_valid_decimal(current.providerRevision, 128) or
   not subtitle_valid_generation(current.generation) or
   not subtitle_valid_decimal(current.revision, 128) then
  return { "state_collision" }
end

return { "authority", current.providerRevision, current.generation, current.revision }
