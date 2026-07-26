"use strict";

const path = require("node:path");
const { Readable } = require("node:stream");
const zlib = require("node:zlib");
const yauzl = require("yauzl");

const DEFAULT_SUBTITLE_LIMITS = Object.freeze({
  maxInputBytes: 4 * 1024 * 1024,
  maxTextBytes: 2 * 1024 * 1024,
  maxArchiveEntries: 64,
  maxArchiveEntryBytes: 8 * 1024 * 1024,
  maxArchiveTotalBytes: 12 * 1024 * 1024,
  maxExpansionRatio: 100,
});

const HARD_LIMITS = Object.freeze({
  maxInputBytes: 16 * 1024 * 1024,
  maxTextBytes: 8 * 1024 * 1024,
  maxArchiveEntries: 256,
  maxArchiveEntryBytes: 32 * 1024 * 1024,
  maxArchiveTotalBytes: 64 * 1024 * 1024,
  maxExpansionRatio: 500,
});

const TEXT_EXTENSIONS = Object.freeze(
  new Set([".srt", ".vtt", ".ass", ".ssa", ".smi", ".sami", ".sub", ".txt"])
);
const ARCHIVE_EXTENSIONS = Object.freeze(new Set([".zip", ".gz", ".gzip"]));
const MPEG_PACK_START_CODE = Buffer.from([0x00, 0x00, 0x01, 0xba]);
const MPEG_PRIVATE_STREAM_START_CODE = Buffer.from([0x00, 0x00, 0x01, 0xbd]);
const FORMAT_METADATA = Object.freeze({
  srt: Object.freeze({ extension: ".srt", mediaType: "application/x-subrip", priority: 0 }),
  vtt: Object.freeze({ extension: ".vtt", mediaType: "text/vtt", priority: 1 }),
  ass: Object.freeze({ extension: ".ass", mediaType: "text/x-ssa", priority: 2 }),
  ssa: Object.freeze({ extension: ".ssa", mediaType: "text/x-ssa", priority: 3 }),
  sami: Object.freeze({ extension: ".smi", mediaType: "application/x-sami", priority: 4 }),
  microdvd: Object.freeze({ extension: ".sub", mediaType: "text/x-microdvd", priority: 5 }),
  txt: Object.freeze({ extension: ".txt", mediaType: "text/plain", priority: 6 }),
});
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let value = 0; value < 256; value += 1) {
    let crc = value;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
    table[value] = crc >>> 0;
  }
  return table;
})();

function subtitleError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function crc32(payload) {
  let crc = 0xffffffff;
  for (const byte of payload) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function readLimit(options, name) {
  const value = options[name] ?? DEFAULT_SUBTITLE_LIMITS[name];
  if (!Number.isSafeInteger(value) || value < 1 || value > HARD_LIMITS[name]) {
    throw new TypeError(name + " must be a bounded positive integer");
  }
  return value;
}

function readLimits(options) {
  const limits = {};
  for (const name of Object.keys(DEFAULT_SUBTITLE_LIMITS)) {
    limits[name] = readLimit(options, name);
  }
  if (limits.maxTextBytes > limits.maxArchiveEntryBytes) {
    throw new TypeError("maxTextBytes cannot exceed maxArchiveEntryBytes");
  }
  if (limits.maxArchiveEntryBytes > limits.maxArchiveTotalBytes) {
    throw new TypeError("maxArchiveEntryBytes cannot exceed maxArchiveTotalBytes");
  }
  return Object.freeze(limits);
}

function ensureBuffer(value) {
  if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) {
    throw new TypeError("subtitle payload must be bytes");
  }
  return Buffer.from(value);
}

function extensionHint(fileName) {
  if (typeof fileName !== "string" || fileName.length > 2048) return "";
  const withoutQuery = fileName.split(/[?#]/, 1)[0];
  return path.posix.extname(withoutQuery.replaceAll("\\", "/")).toLowerCase();
}

function mediaTypeHint(contentType) {
  if (typeof contentType !== "string") return "";
  return contentType.split(";", 1)[0].trim().toLowerCase();
}

function isZipPayload(payload) {
  return (
    payload.length >= 4 &&
    payload[0] === 0x50 &&
    payload[1] === 0x4b &&
    ((payload[2] === 0x03 && payload[3] === 0x04) ||
      (payload[2] === 0x05 && payload[3] === 0x06) ||
      (payload[2] === 0x07 && payload[3] === 0x08))
  );
}

function isGzipPayload(payload) {
  return payload.length >= 2 && payload[0] === 0x1f && payload[1] === 0x8b;
}

function normalizeCharset(value) {
  if (typeof value !== "string" || !value) return null;
  const normalized = value.trim().toLowerCase().replaceAll("_", "-");
  const aliases = new Map([
    ["utf8", "utf-8"],
    ["utf-8", "utf-8"],
    ["utf16", "utf-16le"],
    ["utf-16", "utf-16le"],
    ["utf-16le", "utf-16le"],
    ["utf-16be", "utf-16be"],
    ["windows-1252", "windows-1252"],
    ["cp1252", "windows-1252"],
    ["iso-8859-1", "windows-1252"],
    ["latin1", "windows-1252"],
  ]);
  const charset = aliases.get(normalized);
  if (!charset) {
    throw subtitleError("subtitle_charset_unsupported", "subtitle character set is unsupported");
  }
  return charset;
}

function decodeUtf16Be(payload) {
  if (payload.length % 2 !== 0) {
    throw subtitleError("subtitle_text_invalid", "UTF-16 subtitle text has an odd byte length");
  }
  const swapped = Buffer.allocUnsafe(payload.length);
  for (let index = 0; index < payload.length; index += 2) {
    swapped[index] = payload[index + 1];
    swapped[index + 1] = payload[index];
  }
  return new TextDecoder("utf-16le", { fatal: true }).decode(swapped);
}

function decodeSubtitleText(payload, charsetHint) {
  let body = payload;
  let charset = normalizeCharset(charsetHint);
  if (body.length >= 3 && body.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) {
    body = body.subarray(3);
    charset = "utf-8";
  } else if (body.length >= 2 && body[0] === 0xff && body[1] === 0xfe) {
    body = body.subarray(2);
    charset = "utf-16le";
  } else if (body.length >= 2 && body[0] === 0xfe && body[1] === 0xff) {
    body = body.subarray(2);
    charset = "utf-16be";
  } else if (!charset && body.length >= 4) {
    let evenNulls = 0;
    let oddNulls = 0;
    const sampleLength = Math.min(body.length - (body.length % 2), 512);
    for (let index = 0; index < sampleLength; index += 2) {
      if (body[index] === 0) evenNulls += 1;
      if (body[index + 1] === 0) oddNulls += 1;
    }
    const pairs = sampleLength / 2;
    if (pairs > 0 && oddNulls / pairs > 0.4) charset = "utf-16le";
    else if (pairs > 0 && evenNulls / pairs > 0.4) charset = "utf-16be";
  }

  if ((charset === "utf-16le" || charset === "utf-16be") && body.length % 2 !== 0) {
    throw subtitleError("subtitle_text_invalid", "UTF-16 subtitle text has an odd byte length");
  }
  let text;
  try {
    if (charset === "utf-16be") text = decodeUtf16Be(body);
    else if (charset) text = new TextDecoder(charset, { fatal: true }).decode(body);
    else text = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch (error) {
    if (charset) {
      throw subtitleError("subtitle_text_invalid", "subtitle text could not be decoded");
    }
    try {
      text = new TextDecoder("windows-1252", { fatal: true }).decode(body);
    } catch (_fallbackError) {
      throw subtitleError("subtitle_text_invalid", "subtitle text could not be decoded");
    }
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(text)) {
    throw subtitleError("subtitle_text_invalid", "subtitle text contains binary controls");
  }
  const normalized = text.replaceAll("\r\n", "\n").replaceAll("\r", "\n").replace(/^\ufeff/, "");
  if (!normalized.trim()) throw subtitleError("subtitle_text_empty", "subtitle text is empty");
  if (/^\s*(?:<!doctype\s+html|<html\b)/i.test(normalized)) {
    throw subtitleError("subtitle_text_invalid", "upstream payload is not a subtitle");
  }
  return normalized.endsWith("\n") ? normalized : normalized + "\n";
}

function detectTextFormat(text, hintExtension) {
  if (/^\s*WEBVTT(?:[ \t].*)?(?:\n|$)/i.test(text)) return "vtt";
  if (/^\s*\[Script Info\][\s\S]*?^\s*\[Events\]/im.test(text)) {
    if (hintExtension === ".ssa" || /^\s*\[V4 Styles\]/im.test(text)) return "ssa";
    return "ass";
  }
  if (/<\s*SAMI\b|<\s*SYNC\b/i.test(text)) return "sami";
  if (/^\s*\{\d+\}\{\d*\}[^\n]+/m.test(text)) return "microdvd";
  if (
    /^\s*(?:\d+\s*\n\s*)?\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}\s*-->\s*/m.test(text)
  ) {
    return "srt";
  }
  return "txt";
}

function normalizeTextPayload(payload, options, hintExtension) {
  if (payload.length > options.limits.maxTextBytes) {
    throw subtitleError("subtitle_text_too_large", "subtitle text exceeds the byte limit");
  }
  const text = decodeSubtitleText(payload, options.charset);
  const format = detectTextFormat(text, hintExtension);
  const metadata = FORMAT_METADATA[format];
  const normalizedData = Buffer.from(text, "utf8");
  if (normalizedData.length > options.limits.maxTextBytes) {
    throw subtitleError("subtitle_text_too_large", "subtitle text exceeds the byte limit");
  }
  return Object.freeze({
    type: "text",
    format,
    extension: metadata.extension,
    mediaType: metadata.mediaType,
    data: normalizedData,
  });
}

async function readBoundedStream(stream, maximum, signal) {
  const onAbort = () => stream.destroy(subtitleError("subtitle_aborted", "subtitle processing canceled"));
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  try {
    const chunks = [];
    let total = 0;
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.length;
      if (total > maximum) {
        stream.destroy();
        throw subtitleError(
          "subtitle_decompression_limit",
          "subtitle decompression exceeds the byte limit"
        );
      }
      chunks.push(buffer);
    }
    return Buffer.concat(chunks, total);
  } finally {
    if (signal) signal.removeEventListener("abort", onAbort);
  }
}

async function gunzipPayload(payload, options) {
  const maximum = Math.min(
    options.limits.maxArchiveEntryBytes,
    Math.max(1, payload.length) * options.limits.maxExpansionRatio
  );
  const gunzip = zlib.createGunzip();
  try {
    return await readBoundedStream(Readable.from([payload]).pipe(gunzip), maximum, options.signal);
  } catch (error) {
    if (error && typeof error.code === "string" && error.code.startsWith("subtitle_")) {
      throw error;
    }
    throw subtitleError("subtitle_gzip_invalid", "subtitle gzip payload is invalid");
  } finally {
    gunzip.destroy();
  }
}

function sanitizeArchivePath(fileName) {
  const isDirectory = typeof fileName === "string" && fileName.endsWith("/");
  const pathValue = isDirectory ? fileName.slice(0, -1) : fileName;
  if (
    typeof fileName !== "string" ||
    !fileName ||
    fileName.length > 1024 ||
    fileName.includes("\\") ||
    fileName.startsWith("/") ||
    /^[A-Za-z]:/.test(fileName) ||
    /[\u0000-\u001f\u007f]/.test(fileName)
  ) {
    throw subtitleError("subtitle_archive_path", "subtitle archive path is unsafe");
  }
  const segments = pathValue.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw subtitleError("subtitle_archive_path", "subtitle archive path is unsafe");
  }
  return segments.join("/") + (isDirectory ? "/" : "");
}

function openZip(payload) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(
      payload,
      {
        autoClose: true,
        decodeStrings: true,
        lazyEntries: true,
        strictFileNames: true,
        validateEntrySizes: true,
      },
      (error, zipfile) => {
        if (error) {
          reject(subtitleError("subtitle_zip_invalid", "subtitle ZIP payload is invalid"));
        } else {
          resolve(zipfile);
        }
      }
    );
  });
}

function openEntryStream(zipfile, entry) {
  return new Promise((resolve, reject) => {
    zipfile.openReadStream(entry, (error, stream) => {
      if (error) reject(error);
      else resolve(stream);
    });
  });
}

function entryTypeIsSafe(entry, isDirectory) {
  const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
  const fileType = mode & 0xf000;
  if (!fileType) return true;
  return isDirectory ? fileType === 0x4000 : fileType === 0x8000;
}

async function collectZipEntries(payload, options) {
  const zipfile = await openZip(payload);
  if (
    !Number.isSafeInteger(zipfile.entryCount) ||
    zipfile.entryCount > options.limits.maxArchiveEntries
  ) {
    zipfile.close();
    throw subtitleError("subtitle_archive_entries", "subtitle archive has too many entries");
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let entryCount = 0;
    let aggregateSize = 0;
    const records = [];
    const seenPaths = new Set();
    const fail = (error) => {
      if (settled) return;
      settled = true;
      zipfile.close();
      if (error && typeof error.code === "string" && error.code.startsWith("subtitle_")) {
        reject(error);
      } else {
        reject(subtitleError("subtitle_zip_invalid", "subtitle ZIP payload is invalid"));
      }
    };

    zipfile.once("error", fail);
    zipfile.on("entry", (entry) => {
      Promise.resolve()
        .then(async () => {
          entryCount += 1;
          if (entryCount > options.limits.maxArchiveEntries) {
            throw subtitleError("subtitle_archive_entries", "subtitle archive has too many entries");
          }
          const safePath = sanitizeArchivePath(entry.fileName);
          const isDirectory = safePath.endsWith("/");
          if (!entryTypeIsSafe(entry, isDirectory)) {
            throw subtitleError("subtitle_archive_entry_type", "subtitle archive entry type is unsafe");
          }
          if (entry.generalPurposeBitFlag & 0x1) {
            throw subtitleError("subtitle_archive_encrypted", "encrypted subtitle archives are unsupported");
          }
          if (!isDirectory && entry.compressionMethod !== 0 && entry.compressionMethod !== 8) {
            throw subtitleError(
              "subtitle_archive_compression",
              "subtitle archive compression is unsupported"
            );
          }
          if (
            !Number.isSafeInteger(entry.uncompressedSize) ||
            !Number.isSafeInteger(entry.compressedSize) ||
            entry.uncompressedSize < 0 ||
            entry.compressedSize < 0 ||
            entry.uncompressedSize > options.limits.maxArchiveEntryBytes
          ) {
            throw subtitleError("subtitle_archive_size", "subtitle archive entry is too large");
          }
          if (
            entry.uncompressedSize > Math.max(1, entry.compressedSize) *
              options.limits.maxExpansionRatio
          ) {
            throw subtitleError(
              "subtitle_archive_ratio",
              "subtitle archive expansion ratio is too large"
            );
          }
          aggregateSize += entry.uncompressedSize;
          if (
            aggregateSize > options.limits.maxArchiveTotalBytes ||
            aggregateSize >
              Math.max(1, payload.length) * options.limits.maxExpansionRatio
          ) {
            throw subtitleError("subtitle_archive_size", "subtitle archive is too large");
          }
          if (isDirectory) return;

          const pathKey = safePath.toLowerCase();
          if (seenPaths.has(pathKey)) {
            throw subtitleError("subtitle_archive_duplicate", "subtitle archive has duplicate paths");
          }
          seenPaths.add(pathKey);
          const stream = await openEntryStream(zipfile, entry);
          const data = await readBoundedStream(
            stream,
            options.limits.maxArchiveEntryBytes,
            options.signal
          );
          if (data.length !== entry.uncompressedSize) {
            throw subtitleError("subtitle_zip_invalid", "subtitle ZIP entry size is invalid");
          }
          if (crc32(data) !== (entry.crc32 >>> 0)) {
            throw subtitleError("subtitle_zip_crc", "subtitle ZIP entry checksum is invalid");
          }
          const extension = path.posix.extname(safePath).toLowerCase();
          if (
            isZipPayload(data) ||
            isGzipPayload(data) ||
            ARCHIVE_EXTENSIONS.has(extension)
          ) {
            throw subtitleError("subtitle_archive_nested", "nested subtitle archives are unsupported");
          }
          if (!TEXT_EXTENSIONS.has(extension) && extension !== ".idx") return;
          records.push({ data, extension, path: safePath, pathKey });
        })
        .then(() => {
          if (!settled) zipfile.readEntry();
        })
        .catch(fail);
    });
    zipfile.once("end", () => {
      if (settled) return;
      settled = true;
      resolve(records);
    });
    zipfile.readEntry();
  });
}

function candidateRank(candidate) {
  const lowerPath = candidate.path.toLowerCase();
  const basename = path.posix.basename(lowerPath);
  const samplePenalty = /(?:^|[._ -])(?:sample|proof|readme)(?:[._ -]|$)/.test(basename) ? 1 : 0;
  const depth = lowerPath.split("/").length - 1;
  return [samplePenalty, depth, candidate.priority, lowerPath];
}

function compareRank(left, right) {
  const leftRank = candidateRank(left);
  const rightRank = candidateRank(right);
  for (let index = 0; index < leftRank.length; index += 1) {
    if (leftRank[index] < rightRank[index]) return -1;
    if (leftRank[index] > rightRank[index]) return 1;
  }
  return 0;
}

function readPackEnd(payload, offset) {
  if (
    offset < 0 ||
    offset + 12 > payload.length ||
    !payload.subarray(offset, offset + 4).equals(MPEG_PACK_START_CODE)
  ) {
    return null;
  }
  const marker = payload[offset + 4];
  if ((marker & 0xc0) === 0x40) {
    if (offset + 14 > payload.length) return null;
    const end = offset + 14 + (payload[offset + 13] & 0x07);
    return end <= payload.length ? end : null;
  }
  if ((marker & 0xf0) === 0x20) return offset + 12;
  return null;
}

function isVobSubPrivatePacket(payload, offset, packetEnd) {
  if (
    packetEnd > payload.length ||
    offset + 9 > packetEnd ||
    !payload.subarray(offset, offset + 4).equals(MPEG_PRIVATE_STREAM_START_CODE) ||
    (payload[offset + 6] & 0xc0) !== 0x80
  ) {
    return false;
  }
  const headerLength = payload[offset + 8];
  const subtitleOffset = offset + 9 + headerLength;
  if (subtitleOffset >= packetEnd) return false;
  const substreamId = payload[subtitleOffset];
  return substreamId >= 0x20 && substreamId <= 0x3f;
}

function hasVobSubPackEvidence(payload) {
  if (payload.length < 24) return false;
  let cursor = readPackEnd(payload, 0);
  if (cursor === null) return false;
  let foundSubtitlePacket = false;

  while (cursor < payload.length) {
    if (
      cursor + 4 > payload.length ||
      payload[cursor] !== 0x00 ||
      payload[cursor + 1] !== 0x00 ||
      payload[cursor + 2] !== 0x01
    ) {
      return false;
    }
    const streamId = payload[cursor + 3];
    if (streamId === 0xba) {
      cursor = readPackEnd(payload, cursor);
      if (cursor === null) return false;
      continue;
    }
    if (streamId === 0xb9) {
      return foundSubtitlePacket && cursor + 4 === payload.length;
    }
    if (streamId < 0xbb || cursor + 6 > payload.length) return false;

    const packetLength = payload.readUInt16BE(cursor + 4);
    // Unbounded PES packets require start-code scanning, which is unsafe for proof.
    if (packetLength === 0) return false;
    const packetEnd = cursor + 6 + packetLength;
    if (packetEnd > payload.length) return false;
    if (
      streamId === 0xbd &&
      isVobSubPrivatePacket(payload, cursor, packetEnd)
    ) {
      foundSubtitlePacket = true;
    }
    cursor = packetEnd;
  }
  return foundSubtitlePacket;
}

function normalizeVobSubPair(indexRecord, subRecord, options) {
  if (indexRecord.data.length > options.limits.maxTextBytes) {
    throw subtitleError("subtitle_text_too_large", "subtitle text exceeds the byte limit");
  }
  const indexText = decodeSubtitleText(indexRecord.data, options.charset);
  const indexData = Buffer.from(indexText, "utf8");
  if (indexData.length > options.limits.maxTextBytes) {
    throw subtitleError("subtitle_text_too_large", "subtitle text exceeds the byte limit");
  }
  if (!/^\s*#\s*VobSub index file\b/im.test(indexText)) {
    throw subtitleError("subtitle_vobsub_invalid", "VobSub index payload is invalid");
  }
  if (!hasVobSubPackEvidence(subRecord.data)) {
    throw subtitleError("subtitle_vobsub_invalid", "VobSub data payload is invalid");
  }
  return Object.freeze({
    type: "vobsub",
    format: "vobsub",
    files: Object.freeze([
      Object.freeze({
        role: "index",
        extension: ".idx",
        mediaType: "application/x-vobsub",
        data: indexData,
      }),
      Object.freeze({
        role: "sub",
        extension: ".sub",
        mediaType: "application/octet-stream",
        data: Buffer.from(subRecord.data),
      }),
    ]),
  });
}

async function normalizeZipPayload(payload, options) {
  const records = await collectZipEntries(payload, options);
  const byPath = new Map(records.map((record) => [record.pathKey, record]));
  const vobSubPairs = [];
  const vobSubMemberPaths = new Set();
  const invalidPairErrors = [];
  for (const record of records) {
    if (record.extension !== ".idx") continue;
    const stem = record.pathKey.slice(0, -4);
    const sub = byPath.get(stem + ".sub");
    if (!sub) continue;
    vobSubMemberPaths.add(record.pathKey);
    vobSubMemberPaths.add(sub.pathKey);
    try {
      const pair = normalizeVobSubPair(record, sub, options);
      vobSubPairs.push({ normalized: pair, path: record.path, priority: 6 });
    } catch (error) {
      invalidPairErrors.push(error);
    }
  }

  const candidates = [];
  const invalidTextErrors = [];
  for (const record of records) {
    if (!TEXT_EXTENSIONS.has(record.extension) || vobSubMemberPaths.has(record.pathKey)) {
      continue;
    }
    try {
      const normalized = normalizeTextPayload(record.data, options, record.extension);
      candidates.push({
        normalized,
        path: record.path,
        priority: FORMAT_METADATA[normalized.format].priority,
      });
    } catch (error) {
      invalidTextErrors.push(error);
    }
  }

  const actualSubtitleCandidates = [
    ...vobSubPairs,
    ...candidates.filter((candidate) => candidate.normalized.format !== "txt"),
  ];
  if (actualSubtitleCandidates.length) {
    actualSubtitleCandidates.sort(compareRank);
    return actualSubtitleCandidates[0].normalized;
  }
  if (invalidPairErrors.length) throw invalidPairErrors[0];
  if (candidates.length) {
    candidates.sort(compareRank);
    return candidates[0].normalized;
  }
  if (invalidTextErrors.length) throw invalidTextErrors[0];
  throw subtitleError("subtitle_archive_empty", "subtitle archive has no usable subtitle");
}

async function normalizeSubtitlePayload(value, rawOptions = {}) {
  const payload = ensureBuffer(value);
  const limits = readLimits(rawOptions);
  if (payload.length < 1) throw subtitleError("subtitle_payload_empty", "subtitle payload is empty");
  if (payload.length > limits.maxInputBytes) {
    throw subtitleError("subtitle_payload_too_large", "subtitle payload exceeds the byte limit");
  }
  if (
    rawOptions.signal !== undefined &&
    (!rawOptions.signal || typeof rawOptions.signal.aborted !== "boolean")
  ) {
    throw new TypeError("signal must be an AbortSignal");
  }
  if (rawOptions.signal && rawOptions.signal.aborted) {
    throw subtitleError("subtitle_aborted", "subtitle processing canceled");
  }

  const options = {
    charset: rawOptions.charset || null,
    limits,
    signal: rawOptions.signal,
  };
  const extension = extensionHint(rawOptions.fileName);
  const mediaType = mediaTypeHint(rawOptions.contentType);
  const hintedZip = extension === ".zip" || mediaType === "application/zip";
  const hintedGzip =
    extension === ".gz" ||
    extension === ".gzip" ||
    mediaType === "application/gzip" ||
    mediaType === "application/x-gzip";

  if (isZipPayload(payload)) return normalizeZipPayload(payload, options);
  if (hintedZip) throw subtitleError("subtitle_zip_invalid", "subtitle ZIP payload is invalid");
  if (isGzipPayload(payload)) {
    const decoded = await gunzipPayload(payload, options);
    if (isZipPayload(decoded) || isGzipPayload(decoded)) {
      throw subtitleError("subtitle_archive_nested", "nested subtitle archives are unsupported");
    }
    const innerExtension = extensionHint(
      typeof rawOptions.fileName === "string"
        ? rawOptions.fileName.replace(/\.(?:gz|gzip)$/i, "")
        : ""
    );
    return normalizeTextPayload(decoded, options, innerExtension);
  }
  if (hintedGzip || ARCHIVE_EXTENSIONS.has(extension)) {
    throw subtitleError("subtitle_gzip_invalid", "subtitle gzip payload is invalid");
  }
  if (extension === ".idx") {
    throw subtitleError("subtitle_vobsub_pair_required", "VobSub requires a paired IDX/SUB payload");
  }
  return normalizeTextPayload(payload, options, extension);
}

module.exports = {
  DEFAULT_SUBTITLE_LIMITS,
  normalizeSubtitlePayload,
};
