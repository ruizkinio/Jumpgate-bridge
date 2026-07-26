"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const zlib = require("node:zlib");

const { normalizeSubtitlePayload } = require("../lib/subtitle-payload");

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

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function makeZip(entries) {
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;
  for (const item of entries) {
    const name = Buffer.from(item.name, "utf8");
    const data = Buffer.from(item.data || "");
    const method = item.method ?? 0;
    const compressed = method === 8 ? zlib.deflateRawSync(data) : data;
    const uncompressedSize = item.uncompressedSize ?? data.length;
    const compressedSize = item.compressedSize ?? compressed.length;
    const checksum = item.crc32 ?? crc32(data);
    const flags = 0x800 | (item.dataDescriptor ? 0x08 : 0) | (item.flags || 0);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(item.dataDescriptor ? 0 : checksum, 14);
    local.writeUInt32LE(item.dataDescriptor ? 0 : compressedSize, 18);
    local.writeUInt32LE(item.dataDescriptor ? 0 : uncompressedSize, 22);
    local.writeUInt16LE(name.length, 26);
    const descriptor = item.dataDescriptor ? Buffer.alloc(16) : Buffer.alloc(0);
    if (item.dataDescriptor) {
      descriptor.writeUInt32LE(0x08074b50, 0);
      descriptor.writeUInt32LE(checksum, 4);
      descriptor.writeUInt32LE(compressedSize, 8);
      descriptor.writeUInt32LE(uncompressedSize, 12);
    }
    localParts.push(local, name, compressed, descriptor);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x031e, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressedSize, 20);
    central.writeUInt32LE(uncompressedSize, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(
      item.externalAttributes ?? ((0o100644 << 16) >>> 0),
      38
    );
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, name);
    localOffset += local.length + name.length + compressed.length + descriptor.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function makeVobSubData(substreamId = 0x20, emulatePackStart = false) {
  const pack = Buffer.from([
    0x00, 0x00, 0x01, 0xba, 0x44, 0x00, 0x04, 0x00,
    0x04, 0x01, 0x89, 0xc3, 0xf8, 0x00,
  ]);
  const subtitlePayload = Buffer.from(
    emulatePackStart
      ? [
          substreamId, 0x00, 0x0c, 0x00, 0x08, 0x00,
          0x00, 0x01, 0xba, 0x00, 0x00, 0x00,
        ]
      : [substreamId, 0x00, 0x04, 0xaa, 0xbb]
  );
  const pesHeader = Buffer.from([
    0x00, 0x00, 0x01, 0xbd,
    0x00, 0x00,
    0x80, 0x00, 0x00,
  ]);
  pesHeader.writeUInt16BE(3 + subtitlePayload.length, 4);
  return Buffer.concat([pack, pesHeader, subtitlePayload]);
}

function makeUnboundedVobSubData() {
  const payload = makeVobSubData();
  payload.writeUInt16BE(0, 18);
  return payload;
}

test("normalizes supported text subtitle formats to UTF-8 and LF", async () => {
  const cases = [
    ["episode.srt", "1\r\n00:00:01,000 --> 00:00:02,000\r\nHello\r\n", "srt"],
    ["episode.vtt", "WEBVTT\r\n\r\n00:01.000 --> 00:02.000\r\nHello\r\n", "vtt"],
    [
      "episode.ass",
      "[Script Info]\r\nScriptType: v4.00+\r\n[Events]\r\nDialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,Hello\r\n",
      "ass",
    ],
    [
      "episode.ssa",
      "[Script Info]\n[V4 Styles]\n[Events]\nDialogue: Marked=0,0:00:01.00,0:00:02.00,Default,,0,0,0,,Hello\n",
      "ssa",
    ],
    ["episode.smi", "<SAMI>\r\n<BODY><SYNC Start=1000><P>Hello</BODY>\r\n", "sami"],
    ["episode.sub", "{25}{50}Hello\r\n", "microdvd"],
    ["episode.txt", "A plain transcript\r\n", "txt"],
  ];
  for (const [fileName, text, format] of cases) {
    const result = await normalizeSubtitlePayload(Buffer.from(text), { fileName });
    assert.equal(result.type, "text");
    assert.equal(result.format, format);
    assert.equal(result.data.toString().includes("\r"), false);
    assert.equal(result.data.toString().endsWith("\n"), true);
  }

  const utf16 = Buffer.concat([
    Buffer.from([0xff, 0xfe]),
    Buffer.from("1\n00:00:01,000 --> 00:00:02,000\nOlá\n", "utf16le"),
  ]);
  const result = await normalizeSubtitlePayload(utf16, { fileName: "episode.srt" });
  assert.equal(result.format, "srt");
  assert.match(result.data.toString(), /Olá/);
});

test("normalizes bounded gzip and rejects corruption, nesting, and expansion bombs", async () => {
  const source = Buffer.from("WEBVTT\n\n00:01.000 --> 00:02.000\nHello\n");
  const result = await normalizeSubtitlePayload(zlib.gzipSync(source), {
    fileName: "episode.vtt.gz",
  });
  assert.equal(result.format, "vtt");
  assert.deepEqual(result.data, source);

  await assert.rejects(
    normalizeSubtitlePayload(Buffer.from("not gzip"), { fileName: "episode.srt.gz" }),
    (error) => error.code === "subtitle_gzip_invalid"
  );
  await assert.rejects(
    normalizeSubtitlePayload(zlib.gzipSync(source).subarray(0, -3), {
      fileName: "episode.vtt.gz",
    }),
    (error) => error.code === "subtitle_gzip_invalid"
  );
  await assert.rejects(
    normalizeSubtitlePayload(zlib.gzipSync(zlib.gzipSync(source)), {
      fileName: "episode.srt.gz",
    }),
    (error) => error.code === "subtitle_archive_nested"
  );
  await assert.rejects(
    normalizeSubtitlePayload(zlib.gzipSync(Buffer.alloc(4096, 0x41)), {
      fileName: "episode.txt.gz",
      maxExpansionRatio: 2,
    }),
    (error) => error.code === "subtitle_decompression_limit"
  );
});

test("ZIP processing rejects traversal, excess entries, bombs, and corruption", async () => {
  await assert.rejects(
    normalizeSubtitlePayload(
      makeZip([{ name: "../escape.srt", data: "1\n00:00:01,000 --> 00:00:02,000\nNo\n" }]),
      { fileName: "subs.zip" }
    ),
    (error) => error.code === "subtitle_zip_invalid" || error.code === "subtitle_archive_path"
  );
  await assert.rejects(
    normalizeSubtitlePayload(
      makeZip([
        { name: "one.srt", data: "one" },
        { name: "two.srt", data: "two" },
        { name: "three.srt", data: "three" },
      ]),
      { fileName: "subs.zip", maxArchiveEntries: 2 }
    ),
    (error) => error.code === "subtitle_archive_entries"
  );
  await assert.rejects(
    normalizeSubtitlePayload(
      makeZip([
        {
          name: "bomb.srt",
          data: "tiny",
          method: 8,
          uncompressedSize: 1000000,
        },
      ]),
      { fileName: "subs.zip", maxExpansionRatio: 10 }
    ),
    (error) =>
      error.code === "subtitle_archive_ratio" || error.code === "subtitle_archive_size"
  );
  await assert.rejects(
    normalizeSubtitlePayload(
      makeZip([{ name: "large.srt", data: "123456789" }]),
      {
        maxArchiveEntryBytes: 8,
        maxArchiveTotalBytes: 16,
        maxTextBytes: 8,
      }
    ),
    (error) => error.code === "subtitle_archive_size"
  );
  await assert.rejects(
    normalizeSubtitlePayload(
      makeZip([
        { name: "one.srt", data: "123456" },
        { name: "two.srt", data: "123456" },
      ]),
      {
        maxArchiveEntryBytes: 8,
        maxArchiveTotalBytes: 10,
        maxTextBytes: 8,
      }
    ),
    (error) => error.code === "subtitle_archive_size"
  );
  await assert.rejects(
    normalizeSubtitlePayload(Buffer.from("PK\u0003\u0004truncated"), { fileName: "subs.zip" }),
    (error) => error.code === "subtitle_zip_invalid"
  );
  await assert.rejects(
    normalizeSubtitlePayload(
      makeZip([
        {
          name: "corrupt.srt",
          data: "1\n00:00:01,000 --> 00:00:02,000\nCorrupt\n",
          crc32: 0,
        },
      ]),
      { fileName: "subs.zip" }
    ),
    (error) => error.code === "subtitle_zip_crc"
  );
  for (const entries of [
    [
      { name: "duplicate.srt", data: "first" },
      { name: "duplicate.srt", data: "second" },
    ],
    [
      { name: "Episode.srt", data: "first" },
      { name: "episode.SRT", data: "second" },
    ],
  ]) {
    await assert.rejects(
      normalizeSubtitlePayload(makeZip(entries), { fileName: "duplicates.zip" }),
      (error) => error.code === "subtitle_archive_duplicate"
    );
  }
  await assert.rejects(
    normalizeSubtitlePayload(
      makeZip([
        {
          name: "link.srt",
          data: "1\n00:00:01,000 --> 00:00:02,000\nLink\n",
          externalAttributes: (0o120777 << 16) >>> 0,
        },
      ]),
      { fileName: "symlink.zip" }
    ),
    (error) => error.code === "subtitle_archive_entry_type"
  );
  const nestedZip = makeZip([
    { name: "inner.srt", data: "1\n00:00:01,000 --> 00:00:02,000\nInner\n" },
  ]);
  for (const nested of [
    { name: "nested.bin", data: nestedZip },
    { name: "nested.dat", data: zlib.gzipSync(Buffer.from("nested")) },
  ]) {
    await assert.rejects(
      normalizeSubtitlePayload(
        makeZip([
          nested,
          { name: "valid.srt", data: "1\n00:00:01,000 --> 00:00:02,000\nValid\n" },
        ]),
        { fileName: "outer.zip" }
      ),
      (error) => error.code === "subtitle_archive_nested"
    );
  }
});

test("ZIP data descriptors are decoded and checksum-validated", async () => {
  const result = await normalizeSubtitlePayload(
    makeZip([
      {
        name: "descriptor.srt",
        data: "1\n00:00:01,000 --> 00:00:02,000\nDescriptor\n",
        dataDescriptor: true,
        method: 8,
      },
    ]),
    { fileName: "descriptor.zip" }
  );
  assert.equal(result.format, "srt");
  assert.match(result.data.toString(), /Descriptor/);
});

test("ZIP subtitle selection is deterministic and ignores non-subtitle files", async () => {
  const zip = makeZip([
    {
      name: "sample.srt",
      data: "1\n00:00:01,000 --> 00:00:02,000\nSample\n",
      method: 8,
    },
    {
      name: "movie.ass",
      data: "[Script Info]\n[Events]\nDialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,Chosen\n",
      method: 8,
    },
    { name: "poster.jpg", data: Buffer.alloc(64, 0xff) },
  ]);
  const result = await normalizeSubtitlePayload(zip, { fileName: "provider-token.zip" });
  assert.equal(result.format, "ass");
  assert.match(result.data.toString(), /Chosen/);
  assert.deepEqual(Object.keys(result).sort(), [
    "data",
    "extension",
    "format",
    "mediaType",
    "type",
  ]);

  const lexical = makeZip([
    { name: "z.srt", data: "1\n00:00:01,000 --> 00:00:02,000\nZ\n" },
    { name: "a.srt", data: "1\n00:00:01,000 --> 00:00:02,000\nA\n" },
  ]);
  const lexicalResult = await normalizeSubtitlePayload(lexical);
  assert.match(lexicalResult.data.toString(), /\nA\n/);
});

test("ZIP VobSub output requires a safe matching IDX/SUB pair", async () => {
  const zip = makeZip([
    {
      name: "movie.idx",
      data: "# VobSub index file, v7 (do not modify this line!)\nsize: 720x480\nid: en, index: 0\n",
    },
    { name: "movie.sub", data: makeVobSubData() },
  ]);
  const result = await normalizeSubtitlePayload(zip, { fileName: "movie.zip" });
  assert.equal(result.type, "vobsub");
  assert.equal(result.format, "vobsub");
  assert.deepEqual(
    result.files.map((file) => [file.role, file.extension]),
    [
      ["index", ".idx"],
      ["sub", ".sub"],
    ]
  );

  await assert.rejects(
    normalizeSubtitlePayload(
      makeZip([{ name: "movie.idx", data: "# VobSub index file, v7\n" }]),
      { fileName: "movie.zip" }
    ),
    (error) => error.code === "subtitle_archive_empty"
  );
  await assert.rejects(
    normalizeSubtitlePayload(Buffer.from("# VobSub index file, v7\n"), {
      fileName: "movie.idx",
    }),
    (error) => error.code === "subtitle_vobsub_pair_required"
  );

  for (const invalidData of [
    Buffer.alloc(0),
    Buffer.alloc(64, 0x41),
    makeVobSubData(0x10),
    makeVobSubData().subarray(0, -1),
    makeUnboundedVobSubData(),
  ]) {
    await assert.rejects(
      normalizeSubtitlePayload(
        makeZip([
          { name: "movie.idx", data: "# VobSub index file, v7\nid: en, index: 0\n" },
          { name: "movie.sub", data: invalidData },
        ]),
        { fileName: "invalid-vobsub.zip" }
      ),
      (error) => error.code === "subtitle_vobsub_invalid"
    );
  }
});

test("VobSub packet walking ignores pack start-code emulation inside PES payload", async () => {
  const result = await normalizeSubtitlePayload(
    makeZip([
      { name: "movie.idx", data: "# VobSub index file, v7\nid: en, index: 0\n" },
      { name: "movie.sub", data: makeVobSubData(0x20, true) },
    ]),
    { fileName: "start-code-emulation.zip" }
  );
  assert.equal(result.type, "vobsub");
  assert.equal(result.format, "vobsub");
});

test("a valid VobSub pair outranks generic archive text", async () => {
  const result = await normalizeSubtitlePayload(
    makeZip([
      { name: "README.txt", data: "How to use these subtitle files\n" },
      { name: "movie.idx", data: "# VobSub index file, v7\nid: en, index: 0\n" },
      { name: "movie.sub", data: makeVobSubData() },
    ]),
    { fileName: "movie.zip" }
  );
  assert.equal(result.type, "vobsub");
  assert.equal(result.format, "vobsub");
});

test("rejects malformed UTF-16, C0/C1 controls, HTML, and bounded input violations", async () => {
  for (const [payload, options, code] of [
    [Buffer.from("<html><body>provider error</body></html>"), { fileName: "error.srt" }, "subtitle_text_invalid"],
    [Buffer.from([0x41, 0x00, 0x42]), { fileName: "binary.srt" }, "subtitle_text_invalid"],
    [Buffer.from([0xff, 0xfe, 0x41]), { fileName: "odd-le.srt" }, "subtitle_text_invalid"],
    [Buffer.from([0xfe, 0xff, 0x00]), { fileName: "odd-be.srt" }, "subtitle_text_invalid"],
    [Buffer.from([0x41]), { fileName: "explicit-le.srt", charset: "utf-16le" }, "subtitle_text_invalid"],
    [Buffer.from([0x00]), { fileName: "explicit-be.srt", charset: "utf-16be" }, "subtitle_text_invalid"],
    [Buffer.from([0xff, 0xfe, 0x00, 0xd8]), { fileName: "surrogate.srt" }, "subtitle_text_invalid"],
    [Buffer.from("line\u0085break", "utf8"), { fileName: "c1.srt" }, "subtitle_text_invalid"],
    [Buffer.alloc(0), {}, "subtitle_payload_empty"],
    [Buffer.alloc(9, 0x41), { maxInputBytes: 8 }, "subtitle_payload_too_large"],
  ]) {
    await assert.rejects(
      normalizeSubtitlePayload(payload, options),
      (error) => error.code === code
    );
  }

  const whitespace = await normalizeSubtitlePayload(
    Buffer.from("1\n00:00:01,000 --> 00:00:02,000\nHello\tworld\n"),
    { fileName: "whitespace.srt" }
  );
  assert.match(whitespace.data.toString(), /Hello\tworld/);
});
