"use strict";

function asArray(reply, scriptName) {
  if (!Array.isArray(reply)) throw new TypeError(scriptName + " returned an invalid reply");
  return reply;
}

function asString(value, name) {
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  throw new TypeError(name + " is invalid");
}

function asInteger(value, name) {
  const number = Number(Buffer.isBuffer(value) ? value.toString("utf8") : value);
  if (!Number.isSafeInteger(number)) throw new TypeError(name + " is invalid");
  return number;
}

function optionalString(value) {
  if (value === null || value === undefined || value === false) return null;
  return asString(value, "Redis reply value");
}

module.exports = {
  asArray,
  asInteger,
  asString,
  optionalString,
};
