"use strict";

const { types } = require("node:util");

function invalidJson(name, reason) {
  return new TypeError(name + " " + reason);
}

function assertJsonString(value, name) {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit === 0) throw invalidJson(name, "contains NUL");
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const following = value.charCodeAt(index + 1);
      if (!(following >= 0xdc00 && following <= 0xdfff)) {
        throw invalidJson(name, "contains a lone UTF-16 surrogate");
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw invalidJson(name, "contains a lone UTF-16 surrogate");
    }
  }
}

function assertDataProperty(descriptor, name) {
  if (!descriptor || descriptor.enumerable !== true || !("value" in descriptor)) {
    throw invalidJson(name, "contains an unsupported property");
  }
  return descriptor.value;
}

function arrayIndex(key, length) {
  if (typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(key)) return false;
  const index = Number(key);
  return Number.isSafeInteger(index) && index >= 0 && index < length && String(index) === key;
}

function validateJsonGraph(root, name = "value") {
  if (typeof name !== "string" || name.length === 0) throw new TypeError("JSON value name is invalid");
  const active = new Set();
  const stack = [{ value: root, exit: false }];

  while (stack.length > 0) {
    const frame = stack.pop();
    const value = frame.value;
    if (frame.exit) {
      active.delete(value);
      continue;
    }

    if (value === null || typeof value === "boolean") continue;
    if (typeof value === "string") {
      assertJsonString(value, name);
      continue;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw invalidJson(name, "contains an unsupported number");
      if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
        throw invalidJson(name, "contains an unsafe integer");
      }
      continue;
    }
    if (typeof value !== "object") {
      throw invalidJson(name, "contains an unsupported value");
    }
    if (types.isProxy(value)) throw invalidJson(name, "contains a non-plain object");
    if (active.has(value)) throw invalidJson(name, "contains a cycle");

    const children = [];
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        throw invalidJson(name, "contains a non-plain object");
      }
      const keys = Reflect.ownKeys(value);
      if (keys.length !== value.length + 1) {
        throw invalidJson(name, "contains an unsupported array value or property");
      }
      for (const key of keys) {
        if (key === "length") continue;
        if (!arrayIndex(key, value.length)) {
          throw invalidJson(name, "contains an unsupported array property");
        }
        children.push(assertDataProperty(Object.getOwnPropertyDescriptor(value, key), name));
      }
    } else {
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) {
        throw invalidJson(name, "contains a non-plain object");
      }
      for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== "string") {
          throw invalidJson(name, "contains an unsupported symbol property");
        }
        assertJsonString(key, name);
        children.push(assertDataProperty(Object.getOwnPropertyDescriptor(value, key), name));
      }
    }

    active.add(value);
    stack.push({ value, exit: true });
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push({ value: children[index], exit: false });
    }
  }

  return root;
}

function canonicalizeJson(value, name = "value", maximumBytes) {
  if (typeof name !== "string" || name.length === 0) throw new TypeError("JSON value name is invalid");
  if (
    maximumBytes !== undefined &&
    (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1)
  ) {
    throw new TypeError("maximum JSON bytes is invalid");
  }

  validateJsonGraph(value, name);
  const json = JSON.stringify(value);
  const bytes = Buffer.byteLength(json, "utf8");
  if (maximumBytes !== undefined && bytes > maximumBytes) {
    throw new RangeError(name + " exceeds " + maximumBytes + " bytes");
  }
  return { bytes, json, value: JSON.parse(json) };
}

function assertJsonValue(value, name, maximumBytes) {
  return canonicalizeJson(value, name, maximumBytes).value;
}

function stringifyJsonValue(value, name, maximumBytes) {
  return canonicalizeJson(value, name, maximumBytes).json;
}

module.exports = {
  assertJsonValue,
  canonicalizeJson,
  stringifyJsonValue,
  validateJsonGraph,
};
