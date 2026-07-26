-- jg-script:management-generation
if #KEYS ~= 1 or #ARGV ~= 0 then return { "state_collision" } end
local generationType = redis.call("TYPE", KEYS[1])
if type(generationType) == "table" then generationType = generationType.ok end
if generationType == "none" then return { "generation", "0" } end
if generationType ~= "string" then return { "state_collision" } end
local generation = redis.call("GET", KEYS[1])
if string.match(generation, "^[0-9]+$") and #generation <= 16 and
   tonumber(generation) <= 9007199254740991 then
  return { "generation", generation }
end
local revokedGeneration = string.match(generation, "^revoked:([0-9]+)$")
if revokedGeneration and #revokedGeneration <= 16 and
   tonumber(revokedGeneration) <= 9007199254740991 then
  return { "revoked", revokedGeneration }
end
return { "state_collision" }
