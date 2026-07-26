"use strict";

const crypto = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");
const { assertRepository } = require("./storage/contracts");
const { assertIdentifier, codedError } = require("./storage/repository-utils");
const { providerGatewayCapabilities } = require("./provider-support");
const {
  resolveProviderCollectionCoordinator,
} = require("./provider-collection-coordinator");
const { isCompatibleTransportUrl } = require("./stremio-transport");

const MAX_PROVIDERS = 64;
const MAX_BACKUP_ADDONS = 256;
const MAX_DESCRIPTOR_BYTES = 64 * 1024;
const MAX_BACKUP_BYTES = 4 * 1024 * 1024;
const MAX_NESTING_DEPTH = 32;
const JUMPGATE_ADDON_ID = "com.jumpgate.bridge";
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertString(value, name, maximumLength, options = {}) {
  const minimumLength = options.minimumLength === undefined ? 1 : options.minimumLength;
  if (
    typeof value !== "string" ||
    value.length < minimumLength ||
    value.length > maximumLength ||
    (options.trimmed === true && value.trim() !== value) ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new TypeError(name + " is invalid");
  }
  return value;
}

function assertStringArray(value, name, maximumEntries = 128) {
  if (!Array.isArray(value) || value.length > maximumEntries) {
    throw new TypeError(name + " is invalid");
  }
  const seen = new Set();
  for (const item of value) {
    const string = assertString(item, name + " entry", 256);
    if (seen.has(string)) throw new TypeError(name + " contains a duplicate");
    seen.add(string);
  }
  return value;
}

function assertJsonTree(value, name, depth = 0, seen = new Set()) {
  if (depth > MAX_NESTING_DEPTH) throw new TypeError(name + " is nested too deeply");
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(name + " contains a non-finite number");
    return;
  }
  if (typeof value !== "object") throw new TypeError(name + " is not JSON serializable");
  if (seen.has(value)) throw new TypeError(name + " contains a cycle");
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      for (const item of value) assertJsonTree(item, name, depth + 1, seen);
      return;
    }
    if (!isPlainObject(value)) throw new TypeError(name + " contains a non-plain object");
    for (const key of Object.keys(value)) {
      if (FORBIDDEN_KEYS.has(key)) throw new TypeError(name + " contains a forbidden key");
      assertJsonTree(value[key], name, depth + 1, seen);
    }
  } finally {
    seen.delete(value);
  }
}

function cloneBoundedJson(value, name, maximumBytes) {
  assertJsonTree(value, name);
  const serialized = JSON.stringify(value);
  if (serialized === undefined || Buffer.byteLength(serialized, "utf8") > maximumBytes) {
    throw new RangeError(name + " exceeds its size limit");
  }
  const clone = JSON.parse(serialized);
  if (!isDeepStrictEqual(value, clone)) throw new TypeError(name + " is not losslessly JSON serializable");
  return clone;
}

function validateTransportUrl(value, options = {}) {
  const transportUrl = assertString(value, "provider transportUrl", 8192, { trimmed: true });
  let parsed;
  try {
    parsed = new URL(transportUrl);
  } catch (_error) {
    throw new TypeError("provider transportUrl is invalid");
  }
  const gatewaySupported = isCompatibleTransportUrl(transportUrl);
  const previewableProtocol =
    parsed.protocol === "https:" ||
    parsed.protocol === "http:" ||
    parsed.protocol === "ipfs:" ||
    parsed.protocol === "ipns:";
  const descriptorSupported =
    gatewaySupported ||
    (options.allowUnsupported === true && previewableProtocol);
  if (
    !descriptorSupported ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    parsed.hash
  ) {
    throw new TypeError("provider transportUrl is invalid");
  }
  const queryIndex = transportUrl.indexOf("?");
  const rawQuery = queryIndex === -1 ? "" : transportUrl.slice(queryIndex);
  const canonicalKey = parsed.protocol + "//" + parsed.host + parsed.pathname + rawQuery;
  return { parsed, gatewaySupported, canonicalKey };
}

function resourceName(resource, index) {
  if (typeof resource === "string") return assertString(resource, "manifest resource", 256);
  if (!isPlainObject(resource)) throw new TypeError("manifest resources[" + index + "] is invalid");
  const name = assertString(resource.name, "manifest resource name", 256);
  if (resource.types !== undefined && resource.types !== null) {
    assertStringArray(resource.types, "manifest resource types", 128);
  }
  if (resource.idPrefixes !== undefined && resource.idPrefixes !== null) {
    assertStringArray(resource.idPrefixes, "manifest resource idPrefixes", 128);
  }
  return name;
}

function validateDescriptor(input, options = {}) {
  const descriptor = cloneBoundedJson(input, "provider descriptor", MAX_DESCRIPTOR_BYTES);
  if (!isPlainObject(descriptor) || !isPlainObject(descriptor.manifest)) {
    throw new TypeError("provider descriptor is invalid");
  }
  const transport = validateTransportUrl(descriptor.transportUrl, options);
  const manifest = descriptor.manifest;
  const id = assertString(manifest.id, "manifest id", 1024);
  if (id === JUMPGATE_ADDON_ID) {
    throw codedError("recursive_provider", "Jumpgate cannot import itself as a provider");
  }
  const version = assertString(manifest.version, "manifest version", 256);
  if (!SEMVER_PATTERN.test(version)) throw new TypeError("manifest version is invalid");
  assertString(manifest.name, "manifest name", 1024);
  assertStringArray(manifest.types, "manifest types", 128);
  if (!Array.isArray(manifest.resources) || manifest.resources.length > 128) {
    throw new TypeError("manifest resources is invalid");
  }
  const resourceNames = new Set();
  for (let index = 0; index < manifest.resources.length; index += 1) {
    resourceNames.add(resourceName(manifest.resources[index], index));
  }
  if (manifest.idPrefixes !== undefined && manifest.idPrefixes !== null) {
    assertStringArray(manifest.idPrefixes, "manifest idPrefixes", 128);
  }
  if (descriptor.flags !== undefined) {
    if (!isPlainObject(descriptor.flags)) throw new TypeError("provider flags is invalid");
    for (const field of ["official", "protected"]) {
      if (descriptor.flags[field] !== undefined && typeof descriptor.flags[field] !== "boolean") {
        throw new TypeError("provider flags." + field + " is invalid");
      }
    }
  }
  return { descriptor, transport, resourceNames };
}

function summarizeValidated(validated, ordinal) {
  const descriptor = validated.descriptor;
  const manifest = descriptor.manifest;
  const resources = Array.from(validated.resourceNames);
  const behaviorHints = isPlainObject(manifest.behaviorHints) ? manifest.behaviorHints : {};
  const flags = isPlainObject(descriptor.flags) ? descriptor.flags : {};
  const gatewayCapabilities = providerGatewayCapabilities(descriptor);
  const supportsStream = gatewayCapabilities.some((resource) => resource.name === "stream");
  const supportsSubtitles = gatewayCapabilities.some((resource) => resource.name === "subtitles");
  return {
    key: crypto.createHash("sha256").update(validated.transport.canonicalKey, "utf8").digest("hex").slice(0, 24),
    ordinal,
    manifestId: manifest.id,
    name: manifest.name,
    version: manifest.version,
    resources,
    supportsStream,
    supportsSubtitles,
    supportsMeta: validated.resourceNames.has("meta"),
    supportsCatalog: validated.resourceNames.has("catalog") || validated.resourceNames.has("addon_catalog"),
    official: flags.official === true,
    protected: flags.protected === true,
    configurable: behaviorHints.configurable === true || behaviorHints.configurationRequired === true,
    insecureTransport: validated.transport.parsed.protocol === "http:",
    unsupportedTransport: !validated.transport.gatewaySupported,
    gatewayEligible: validated.transport.gatewaySupported && (supportsStream || supportsSubtitles),
  };
}

function validateProviderCollection(descriptors, options = {}) {
  if (!Array.isArray(descriptors) || descriptors.length > MAX_PROVIDERS) {
    throw new TypeError("descriptors must be an array of at most " + MAX_PROVIDERS + " entries");
  }
  const validated = [];
  const transportUrls = new Set();
  for (let index = 0; index < descriptors.length; index += 1) {
    const provider = validateDescriptor(descriptors[index], options);
    if (transportUrls.has(provider.transport.canonicalKey)) {
      throw new TypeError("duplicate provider transportUrl");
    }
    transportUrls.add(provider.transport.canonicalKey);
    validated.push(provider);
  }
  return validated;
}

function assertRevision(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("expectedRevision is invalid");
  return value;
}

class ProviderImportService {
  constructor(options = {}) {
    this._profiles = assertRepository("profiles", options.profiles);
    this._backups = assertRepository("addonCollectionBackups", options.addonCollectionBackups);
    this._providerCollections = resolveProviderCollectionCoordinator(options);
  }

  preview(descriptors) {
    return validateProviderCollection(descriptors, { allowUnsupported: true }).map(summarizeValidated);
  }

  async list(profileId) {
    const id = await this._requireProfile(profileId);
    const collection = await this._providerCollections.list(id);
    const validated = validateProviderCollection(collection.providers.map((item) => item.descriptor));
    return {
      revision: collection.revision,
      providers: validated.map((item, index) => ({
        providerId: collection.providers[index].providerId,
        ...summarizeValidated(item, collection.providers[index].ordinal),
      })),
    };
  }

  async import(profileId, input = {}) {
    const id = await this._requireProfile(profileId);
    if (!isPlainObject(input)) throw new TypeError("provider import is invalid");
    if (Object.prototype.hasOwnProperty.call(input, "backupCollection")) {
      throw new TypeError("backupCollection must be created with the standalone backup operation");
    }
    const expectedRevision = assertRevision(input.expectedRevision);
    const validated = validateProviderCollection(input.descriptors);
    if (validated.some((provider) => !summarizeValidated(provider).gatewayEligible)) {
      throw new TypeError("provider import contains a provider with no usable stream or subtitle capability");
    }
    const descriptors = validated.map((item) => item.descriptor);
    const replaced = await this._providerCollections.replaceAll(
      id,
      descriptors,
      expectedRevision
    );
    return {
      ...replaced,
      providers: validated.map(summarizeValidated),
    };
  }

  async backup(profileId, collection, reason = "before-stremio-addon-update") {
    const id = await this._requireProfile(profileId);
    if (!Array.isArray(collection) || collection.length > MAX_BACKUP_ADDONS) {
      throw new TypeError("addon collection backup is invalid");
    }
    const safeCollection = cloneBoundedJson(collection, "addon collection backup", MAX_BACKUP_BYTES);
    const safeReason = assertString(reason, "backup reason", 256, { trimmed: true });
    return this._backups.create(id, safeCollection, safeReason);
  }

  async _requireProfile(profileId) {
    const id = assertIdentifier(profileId, "profile id");
    const profile = await this._profiles.getById(id);
    if (!profile || profile.status !== "active") {
      throw codedError("profile_unavailable", "profile is unavailable");
    }
    return id;
  }
}

module.exports = {
  JUMPGATE_ADDON_ID,
  ProviderImportService,
  validateDescriptor,
  validateProviderCollection,
};
