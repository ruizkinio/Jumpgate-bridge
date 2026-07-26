"use strict";

const {
  classifyTransportUrl,
  isCompatibleTransportUrl,
  isLegacyStreamIdSupported,
} = require("./stremio-transport");

const GATEWAY_RESOURCES = ["stream", "subtitles"];
const MAX_SELECTED_DESCRIPTORS = 64;
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function hasForbiddenOwnKey(value) {
  return isPlainObject(value) && Object.keys(value).some((key) => FORBIDDEN_KEYS.has(key));
}

function ownValue(value, key) {
  return hasOwn(value, key) ? value[key] : undefined;
}

function requestExtra(request) {
  if (!hasOwn(request, "extra") || request.extra === undefined) return [];
  if (!Array.isArray(request.extra)) return null;
  const extra = [];
  for (const entry of request.extra) {
    let name;
    let value;
    if (Array.isArray(entry)) {
      if (entry.length !== 2 || !hasOwn(entry, 0) || !hasOwn(entry, 1)) return null;
      [name, value] = entry;
    } else if (isPlainObject(entry) && hasOwn(entry, "name") && hasOwn(entry, "value")) {
      name = entry.name;
      value = entry.value;
    } else {
      return null;
    }
    if (typeof name !== "string" || typeof value !== "string" || FORBIDDEN_KEYS.has(name)) {
      return null;
    }
    extra.push({ name, value });
  }
  return extra;
}

function resourceName(resource) {
  if (typeof resource === "string") return resource;
  if (!isPlainObject(resource) || hasForbiddenOwnKey(resource) || !hasOwn(resource, "name")) {
    return null;
  }
  return typeof ownValue(resource, "name") === "string" ? ownValue(resource, "name") : null;
}

function firstManifestResource(manifest, name) {
  const resources = ownValue(manifest, "resources");
  if (!Array.isArray(resources)) return null;
  for (const resource of resources) {
    if (resourceName(resource) === name) return resource;
  }
  return null;
}

function resourceConstraints(manifest, resourceNameValue) {
  const resource = firstManifestResource(manifest, resourceNameValue);
  if (resource === null) return null;
  const short = typeof resource === "string";
  const types = short ? ownValue(manifest, "types") : ownValue(resource, "types");
  const idPrefixes = short
    ? ownValue(manifest, "idPrefixes")
    : ownValue(resource, "idPrefixes");
  if (!isStringArray(types)) return null;
  if (idPrefixes !== undefined && idPrefixes !== null && !isStringArray(idPrefixes)) return null;
  return {
    types,
    idPrefixes: idPrefixes === undefined || idPrefixes === null ? null : idPrefixes,
  };
}

function legacySafePrefixes(idPrefixes) {
  if (idPrefixes === null || idPrefixes.length === 0 || idPrefixes.includes("")) return [];
  const declared = idPrefixes;
  const safe = [];
  for (const supportedPrefix of ["tt", "UC"]) {
    if (declared.some((declaredPrefix) => supportedPrefix.startsWith(declaredPrefix))) {
      if (!safe.includes(supportedPrefix)) safe.push(supportedPrefix);
    }
    for (const declaredPrefix of declared) {
      if (declaredPrefix.startsWith(supportedPrefix) && !safe.includes(declaredPrefix)) {
        safe.push(declaredPrefix);
      }
    }
  }
  // Legacy Core can encode arbitrary two/three-part IDs. A declared prefix that
  // already contains the separator preserves those addons; runtime routing still
  // validates the full ID.
  for (const declaredPrefix of declared) {
    if (declaredPrefix.includes(":") && !safe.includes(declaredPrefix)) {
      safe.push(declaredPrefix);
    }
  }
  return safe;
}

function effectiveResourceConstraints(descriptor, resourceNameValue) {
  const manifest = descriptorFromSelection(descriptor);
  if (
    !manifest ||
    !isPlainObject(ownValue(manifest, "manifest")) ||
    hasForbiddenOwnKey(ownValue(manifest, "manifest"))
  ) {
    return null;
  }
  let transportKind;
  try {
    transportKind = classifyTransportUrl(ownValue(manifest, "transportUrl"));
  } catch (_error) {
    return null;
  }
  const constraints = resourceConstraints(ownValue(manifest, "manifest"), resourceNameValue);
  if (!constraints || constraints.types.length === 0) return null;
  if (transportKind !== "legacy" || resourceNameValue !== "stream") {
    return { ...constraints, transportKind };
  }
  const idPrefixes = legacySafePrefixes(constraints.idPrefixes);
  const unrestricted =
    constraints.idPrefixes === null ||
    constraints.idPrefixes.length === 0 ||
    constraints.idPrefixes.includes("");
  return unrestricted || idPrefixes.length
    ? { ...constraints, idPrefixes, transportKind }
    : null;
}

function providerGatewayCapabilities(selection) {
  const resources = [];
  for (const resourceNameValue of GATEWAY_RESOURCES) {
    const constraints = effectiveResourceConstraints(selection, resourceNameValue);
    if (constraints) resources.push({ name: resourceNameValue, ...constraints });
  }
  return resources;
}

function catalogExtraProperties(catalog) {
  const fullExtra = ownValue(catalog, "extra");
  if (Array.isArray(fullExtra)) {
    const properties = [];
    for (const property of fullExtra) {
      if (
        !isPlainObject(property) ||
        hasForbiddenOwnKey(property) ||
        typeof ownValue(property, "name") !== "string"
      ) {
        return null;
      }
      properties.push({
        name: ownValue(property, "name"),
        required: ownValue(property, "isRequired") === true,
      });
    }
    return properties;
  }

  const supportedValue = ownValue(catalog, "extraSupported");
  const requiredValue = ownValue(catalog, "extraRequired");
  const supported = supportedValue === undefined ? [] : supportedValue;
  const required = requiredValue === undefined ? [] : requiredValue;
  if (!isStringArray(supported) || !isStringArray(required)) return null;
  return supported.map((name) => ({ name, required: required.includes(name) }));
}

function isCatalogExtraSupported(catalog, extra) {
  const properties = catalogExtraProperties(catalog);
  if (!properties) return false;
  const allSupported = extra.every((entry) =>
    properties.some((property) => property.name === entry.name)
  );
  const requiredSatisfied = properties
    .filter((property) => property.required)
    .every((property) => extra.some((entry) => entry.name === property.name));
  return allSupported && requiredSatisfied;
}

function isCatalogResourceSupported(manifest, request, extra, field) {
  const catalogs = ownValue(manifest, field);
  if (!Array.isArray(catalogs)) return false;
  return catalogs.some((catalog) =>
    isPlainObject(catalog) &&
    !hasForbiddenOwnKey(catalog) &&
    ownValue(catalog, "type") === ownValue(request, "type") &&
    ownValue(catalog, "id") === ownValue(request, "id") &&
    isCatalogExtraSupported(catalog, extra)
  );
}

function isResourceSupported(manifest, request) {
  if (
    !isPlainObject(manifest) ||
    !isPlainObject(request) ||
    hasForbiddenOwnKey(manifest) ||
    hasForbiddenOwnKey(request) ||
    typeof ownValue(request, "resource") !== "string" ||
    typeof ownValue(request, "type") !== "string" ||
    typeof ownValue(request, "id") !== "string"
  ) {
    return false;
  }
  const extra = requestExtra(request);
  if (!extra) return false;

  if (ownValue(request, "resource") === "catalog") {
    return isCatalogResourceSupported(manifest, request, extra, "catalogs");
  }
  if (ownValue(request, "resource") === "addon_catalog") {
    return isCatalogResourceSupported(manifest, request, extra, "addonCatalogs");
  }

  const constraints = resourceConstraints(manifest, ownValue(request, "resource"));
  if (!constraints || !constraints.types.includes(ownValue(request, "type"))) return false;
  const prefixes = constraints.idPrefixes;
  return (
    prefixes === null ||
    prefixes.length === 0 ||
    prefixes.some((prefix) => ownValue(request, "id").startsWith(prefix))
  );
}

function isProviderResourceSupported(selection, request) {
  const descriptor = descriptorFromSelection(selection);
  if (!descriptor || !isResourceSupported(ownValue(descriptor, "manifest"), request)) return false;
  let transportKind;
  try {
    transportKind = classifyTransportUrl(ownValue(descriptor, "transportUrl"));
  } catch (_error) {
    return false;
  }
  return !(
    transportKind === "legacy" &&
    ownValue(request, "resource") === "stream" &&
    !isLegacyStreamIdSupported(ownValue(request, "id"))
  );
}

function appendUnique(target, seen, values) {
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    target.push(value);
  }
}

function descriptorFromSelection(selection) {
  if (!isPlainObject(selection) || hasForbiddenOwnKey(selection)) return null;
  if (typeof ownValue(selection, "transportUrl") === "string") return selection;
  const descriptor = ownValue(selection, "descriptor");
  if (isPlainObject(descriptor) && !hasForbiddenOwnKey(descriptor)) return descriptor;
  return null;
}

function createCapability(name) {
  return {
    name,
    types: [],
    typeSet: new Set(),
    idPrefixes: [],
    prefixSet: new Set(),
    unrestrictedIds: false,
  };
}

function computeAdvertisedCapabilities(selectedDescriptors) {
  if (
    !Array.isArray(selectedDescriptors) ||
    selectedDescriptors.length > MAX_SELECTED_DESCRIPTORS
  ) {
    throw new TypeError(
      "selectedDescriptors must be an array of at most " + MAX_SELECTED_DESCRIPTORS + " entries"
    );
  }

  const capabilities = new Map(
    GATEWAY_RESOURCES.map((resource) => [resource, createCapability(resource)])
  );
  const globalTypes = [];
  const globalTypeSet = new Set();
  const globalPrefixes = [];
  const globalPrefixSet = new Set();
  let globalUnrestrictedIds = false;

  for (const selection of selectedDescriptors) {
    const descriptor = descriptorFromSelection(selection);
    if (!descriptor || !isCompatibleTransportUrl(ownValue(descriptor, "transportUrl"))) continue;

    for (const constraints of providerGatewayCapabilities(descriptor)) {
      const resourceNameValue = constraints.name;
      const capability = capabilities.get(resourceNameValue);
      appendUnique(capability.types, capability.typeSet, constraints.types);
      appendUnique(globalTypes, globalTypeSet, constraints.types);

      const unrestricted =
        constraints.idPrefixes === null ||
        constraints.idPrefixes.length === 0 ||
        constraints.idPrefixes.includes("");
      if (unrestricted) {
        capability.unrestrictedIds = true;
        globalUnrestrictedIds = true;
      } else {
        appendUnique(capability.idPrefixes, capability.prefixSet, constraints.idPrefixes);
        appendUnique(globalPrefixes, globalPrefixSet, constraints.idPrefixes);
      }
    }
  }

  const resources = [];
  for (const resourceNameValue of GATEWAY_RESOURCES) {
    const capability = capabilities.get(resourceNameValue);
    if (capability.types.length === 0) continue;
    resources.push({
      name: resourceNameValue,
      types: capability.types,
      idPrefixes: capability.unrestrictedIds ? [] : capability.idPrefixes,
    });
  }
  return {
    types: globalTypes,
    idPrefixes: globalUnrestrictedIds ? [] : globalPrefixes,
    resources,
  };
}

module.exports = {
  GATEWAY_RESOURCES,
  computeAdvertisedCapabilities,
  computeProviderCapabilityUnions: computeAdvertisedCapabilities,
  effectiveResourceConstraints,
  isProviderResourceSupported,
  isResourceSupported,
  manifestSupportsResource: isResourceSupported,
  providerGatewayCapabilities,
};
