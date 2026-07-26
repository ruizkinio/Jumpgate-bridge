"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  MAX_PREPARED_BODY_BYTES,
  normalizePreparedHttpHeadResponse,
} = require("../lib/prepared-http-response");

test("prepared HEAD responses preserve representation length without materializing a body", () => {
  const response = normalizePreparedHttpHeadResponse({
    status: 200,
    headers: {
      "Content-Type": "text/vtt",
      "Content-Length": "4096",
    },
  });

  assert.deepEqual(response, {
    status: 200,
    headers: {
      "content-length": "4096",
      "content-type": "text/vtt",
    },
  });
  assert.equal(Object.hasOwn(response, "body"), false);
});

test("prepared HEAD responses reject ambiguous lengths and response bodies", () => {
  for (const contentLength of ["", "00", "+1", "1.0", "-1", "not-a-length"]) {
    assert.throws(
      () => normalizePreparedHttpHeadResponse({
        status: 200,
        headers: { "Content-Length": contentLength },
      }),
      /Content-Length/
    );
  }

  assert.throws(
    () => normalizePreparedHttpHeadResponse({
      status: 200,
      headers: { "Content-Length": "0" },
      body: Buffer.alloc(0),
    }),
    /HEAD response is invalid/
  );
  assert.throws(
    () => normalizePreparedHttpHeadResponse({
      status: 200,
      headers: { "Content-Length": String(MAX_PREPARED_BODY_BYTES + 1) },
    }),
    /exceeds the maximum size/
  );
});
