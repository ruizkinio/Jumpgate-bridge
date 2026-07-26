"use strict";

const HASH_PATTERN = /^[a-f0-9]{64}$/;

function assertPositiveInteger(value, name, maximum) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(name + " is invalid");
  }
  return value;
}

function assertBoundedString(value, name, maximumLength) {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > maximumLength ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new TypeError(name + " is invalid");
  }
  return value;
}

function validateResult(result, limit) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new TypeError("rate limit result is invalid");
  }
  if (typeof result.allowed !== "boolean") {
    throw new TypeError("rate limit allowed result is invalid");
  }
  if (!Number.isSafeInteger(result.remaining) || result.remaining < 0 || result.remaining > limit) {
    throw new TypeError("rate limit remaining result is invalid");
  }
  if (!Number.isSafeInteger(result.resetAt) || result.resetAt < 1) {
    throw new TypeError("rate limit reset result is invalid");
  }
  return result;
}

function setRateLimitHeaders(res, limit, windowMs, remaining, resetAfterSec) {
  const windowSec = Math.max(1, Math.ceil(windowMs / 1000));
  res.setHeader("RateLimit-Policy", String(limit) + ";w=" + String(windowSec));
  res.setHeader("RateLimit-Limit", String(limit));
  res.setHeader("RateLimit-Remaining", String(remaining));
  res.setHeader("RateLimit-Reset", String(resetAfterSec));
}

function sendUnavailable(res) {
  res.setHeader("Cache-Control", "no-store");
  return res.status(503).json({ ok: false, error: "service_unavailable" });
}

function createRateLimitMiddleware(options = {}) {
  const scope = assertBoundedString(options.scope, "rate limit scope", 128);
  const limit = assertPositiveInteger(options.limit, "rate limit", 1000000);
  const windowMs = assertPositiveInteger(
    options.windowMs,
    "rate limit window",
    24 * 60 * 60 * 1000
  );
  const message = assertBoundedString(options.message, "rate limit message", 512);
  const getRepository = options.getRepository;
  const keyGenerator = options.keyGenerator;
  const hashClientKey = options.hashClientKey;
  const skip = options.skip || (() => false);
  const clock = options.clock || Date.now;

  if (typeof getRepository !== "function") throw new TypeError("getRepository is required");
  if (typeof keyGenerator !== "function") throw new TypeError("keyGenerator is required");
  if (typeof hashClientKey !== "function") throw new TypeError("hashClientKey is required");
  if (typeof skip !== "function") throw new TypeError("skip must be a function");
  if (typeof clock !== "function") throw new TypeError("clock must be a function");

  return async function repositoryRateLimit(req, res, next) {
    let skipped;
    try {
      skipped = await skip(req);
    } catch (_error) {
      return sendUnavailable(res);
    }

    // Downstream control flow is not a rate-limit infrastructure failure.
    if (skipped) return next();

    let result;
    let resetAfterSec;
    try {
      const clientSignal = assertBoundedString(
        await keyGenerator(req),
        "rate limit client signal",
        512
      );
      const clientKeyHash = await hashClientKey(clientSignal);
      if (typeof clientKeyHash !== "string" || !HASH_PATTERN.test(clientKeyHash)) {
        throw new TypeError("rate limit client hash is invalid");
      }

      const repository = await getRepository();
      if (!repository || typeof repository.consume !== "function") {
        throw new TypeError("rate limit repository is unavailable");
      }
      result = validateResult(
        await repository.consume(scope, clientKeyHash, limit, windowMs),
        limit
      );
      const now = Number(clock());
      if (!Number.isFinite(now)) throw new TypeError("rate limit clock is invalid");
      resetAfterSec = Math.max(1, Math.ceil((result.resetAt - now) / 1000));

      setRateLimitHeaders(res, limit, windowMs, result.remaining, resetAfterSec);
    } catch (_error) {
      return sendUnavailable(res);
    }

    if (result.allowed) return next();

    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Retry-After", String(resetAfterSec));
    return res.status(429).json({
      ok: false,
      error: message,
      retryAfterSec: resetAfterSec,
    });
  };
}

module.exports = {
  createRateLimitMiddleware,
};
