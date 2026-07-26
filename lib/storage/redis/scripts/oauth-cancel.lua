-- jg-script:oauth-cancel
local removed = redis.call("DEL", KEYS[1])
redis.call("ZREM", KEYS[2], KEYS[1])
if removed == 1 then return { "cancelled" } end
return { "not_found" }
