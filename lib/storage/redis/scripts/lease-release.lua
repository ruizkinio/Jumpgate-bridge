-- jg-script:lease-release
if redis.call("EXISTS", KEYS[1]) == 0 then
  redis.call("ZREM", KEYS[3], KEYS[1])
  return { "not_owner" }
end
if redis.call("HGET", KEYS[1], "leaseTokenHash") ~= ARGV[1] then return { "not_owner" } end
if redis.call("GET", KEYS[2]) ~= KEYS[1] then return { "not_owner" } end
redis.call("DEL", KEYS[1], KEYS[2])
redis.call("ZREM", KEYS[3], KEYS[1])
return { "released" }
