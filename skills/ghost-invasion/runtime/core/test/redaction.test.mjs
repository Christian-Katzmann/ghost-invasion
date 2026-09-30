import assert from "node:assert/strict";
import test from "node:test";
import zlib from "node:zlib";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  REDACTED,
  collectStorageStateSecrets,
  redactDroneEvidence,
  redactHarFile,
  redactTraceZip
} from "../dist/redaction.js";

// Targeted unit coverage for the fail-closed redaction module (F6). The end-to-end
// evidence-leak test proves the happy path; these tests pin the fail-closed branches
// (delete-on-failure, corrupt zip, unparseable HAR), the min-secret floor, the atomic
// write (F7), and the broadened bearer-value harvesting (S-002) directly.

const SECRET = "GHOSTLEAK-s3ss10n-c0okie-DO-NOT-PERSIST-7f3a9b2c";

async function tmp() {
  return mkdtemp(join(tmpdir(), "ghost-redact-"));
}

// --- a minimal stored (method 0) zip writer so we can build a real trace.zip the
// module's reader accepts, without depending on the module's own writer. ---
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}

function makeStoredZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const file of files) {
    const nameBuf = Buffer.from(file.name, "utf8");
    const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data, "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 8); // method: stored
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 10); // method: stored
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }
  const localPart = Buffer.concat(locals);
  const centralPart = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralPart.length, 12);
  eocd.writeUInt32LE(localPart.length, 16);
  return Buffer.concat([localPart, centralPart, eocd]);
}

// --- F6: corrupt / non-zip trace is deleted, never left raw -----------------------
test("redactDroneEvidence deletes a corrupt (non-zip) trace rather than leaving it raw", async () => {
  const dir = await tmp();
  try {
    const tracePath = join(dir, "trace.zip");
    await writeFile(tracePath, `not a zip but contains ${SECRET}`);

    const result = await redactDroneEvidence({ droneDir: dir, storageStatePath: null });

    assert.equal(result.trace, false);
    assert.deepEqual(result.deleted, [tracePath]);
    const left = await readdir(dir);
    assert(!left.includes("trace.zip"), "corrupt trace must be deleted, not left on disk");
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("redactTraceZip throws on a corrupt zip (so the caller can fail closed)", async () => {
  const dir = await tmp();
  try {
    const tracePath = join(dir, "trace.zip");
    await writeFile(tracePath, "definitely not a zip");
    await assert.rejects(() => redactTraceZip(tracePath), /trace\.zip/);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

// --- F6: unparseable HAR is value-scrubbed, not deleted ----------------------------
test("redactHarFile value-scrubs an unparseable HAR instead of leaking it", async () => {
  const dir = await tmp();
  try {
    const harPath = join(dir, "network.har");
    // Invalid JSON (trailing comma) that still embeds the live secret.
    await writeFile(harPath, `{ "log": { "entries": [ ${JSON.stringify(SECRET)}, ] }`);

    const harvested = await redactHarFile(harPath, [SECRET]);

    const after = await readFile(harPath, "utf8");
    assert(!after.includes(SECRET), "unparseable HAR must be value-scrubbed");
    assert(after.includes(REDACTED), "scrubbed value should be replaced with the marker");
    assert(harvested.includes(SECRET));
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("redactDroneEvidence value-scrubs an unparseable HAR and keeps the file", async () => {
  const dir = await tmp();
  try {
    const harPath = join(dir, "network.har");
    await writeFile(harPath, `{ not valid json ${JSON.stringify(SECRET)} `);
    const statePath = join(dir, "state.json");
    await writeFile(
      statePath,
      JSON.stringify({ cookies: [{ name: "session", value: SECRET }], origins: [] })
    );

    const result = await redactDroneEvidence({ droneDir: dir, storageStatePath: statePath });

    assert.equal(result.har, true);
    assert.deepEqual(result.deleted, []);
    const after = await readFile(harPath, "utf8");
    assert(!after.includes(SECRET), "secret must be scrubbed from the unparseable HAR");
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

// --- F6: the min-secret floor never corrupts short benign values -------------------
test("short benign values are never blanket-replaced (min-secret floor)", async () => {
  const dir = await tmp();
  try {
    // A storageState whose cookie value is short and benign ("en").
    const statePath = join(dir, "state.json");
    await writeFile(
      statePath,
      JSON.stringify({ cookies: [{ name: "lang", value: "en" }], origins: [] })
    );
    const secrets = await collectStorageStateSecrets(statePath);
    assert(!secrets.includes("en"), "short value must not be harvested as a secret");

    // A HAR whose body legitimately contains "en" must survive untouched.
    const harPath = join(dir, "network.har");
    const har = {
      log: {
        entries: [
          {
            request: { headers: [{ name: "accept-language", value: "en" }] },
            response: { content: { text: "lang=en; greeting=hello" } }
          }
        ]
      }
    };
    await writeFile(harPath, JSON.stringify(har));
    await redactHarFile(harPath, secrets);
    const after = await readFile(harPath, "utf8");
    assert(after.includes("lang=en"), "benign short value must not be corrupted");
    assert(after.includes("greeting=hello"));
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

// --- F6: redaction throw -> artifact deleted (general fail-closed contract) --------
test("redactDroneEvidence redacts a valid HAR in place and harvests its auth header", async () => {
  const dir = await tmp();
  try {
    const harPath = join(dir, "network.har");
    const har = {
      log: {
        entries: [
          { request: { headers: [{ name: "Authorization", value: SECRET }], cookies: [] } }
        ]
      }
    };
    await writeFile(harPath, JSON.stringify(har));
    const result = await redactDroneEvidence({ droneDir: dir, storageStatePath: null });
    assert.equal(result.har, true);
    const after = await readFile(harPath, "utf8");
    assert(!after.includes(SECRET));
    assert(after.includes(REDACTED));
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

// --- F7: atomic write leaves no temp residue and never a torn artifact -------------
test("HAR redaction leaves no temp file behind (atomic rename)", async () => {
  const dir = await tmp();
  try {
    const harPath = join(dir, "network.har");
    const har = { log: { entries: [{ request: { headers: [{ name: "cookie", value: SECRET }] } }] } };
    await writeFile(harPath, JSON.stringify(har));
    await redactHarFile(harPath, [SECRET]);
    const left = await readdir(dir);
    assert.deepEqual(left, ["network.har"], `no temp residue expected, saw ${left.join(", ")}`);
    // File is complete, parseable JSON (not a torn write).
    JSON.parse(await readFile(harPath, "utf8"));
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("trace redaction leaves no temp file behind (atomic rename)", async () => {
  const dir = await tmp();
  try {
    const tracePath = join(dir, "trace.zip");
    const network = JSON.stringify({ headers: [{ name: "authorization", value: SECRET }] });
    await writeFile(tracePath, makeStoredZip([{ name: "0-trace.network", data: network }]));
    await redactTraceZip(tracePath, [SECRET]);
    const left = await readdir(dir);
    assert.deepEqual(left, ["trace.zip"], `no temp residue expected, saw ${left.join(", ")}`);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

// --- S-002: broadened harvesting catches bearer tokens outside cookies/headers -----
test("bearer token in response-body.json is harvested and scrubbed", async () => {
  const dir = await tmp();
  try {
    const token = "eyJhbGciOiJIUzI1NiJ9.AAAABBBBCCCCDDDD.signature-xyz-1234567890";
    const bodyPath = join(dir, "response-body.json");
    // The bearer never appears in storageState nor as a structured header — only here.
    await writeFile(
      bodyPath,
      JSON.stringify({ capturedFrom: "target", echoed: `Authorization: Bearer ${token}` })
    );
    const statePath = join(dir, "state.json");
    await writeFile(statePath, JSON.stringify({ cookies: [], origins: [] }));

    const result = await redactDroneEvidence({ droneDir: dir, storageStatePath: statePath });

    assert.equal(result.responseBody, true, "response body should be rewritten");
    const after = await readFile(bodyPath, "utf8");
    assert(!after.includes(token), "bearer token must be scrubbed from response-body.json");
    assert(after.includes(REDACTED));
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("bearer token embedded in a HAR response body is harvested and scrubbed", async () => {
  const dir = await tmp();
  try {
    const token = "abc123.DEF456.ghi789-bearer-only-in-body-0000";
    const harPath = join(dir, "network.har");
    const har = {
      log: {
        entries: [
          { response: { content: { text: `{"echo":"Bearer ${token}"}` } } }
        ]
      }
    };
    await writeFile(harPath, JSON.stringify(har));
    await redactHarFile(harPath, []);
    const after = await readFile(harPath, "utf8");
    assert(!after.includes(token), "bearer token in HAR body must be scrubbed");
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("bearer token in a trace text entry (not a header) is harvested and scrubbed", async () => {
  const dir = await tmp();
  try {
    const token = "trace-only-bearer.AAAA.BBBB.CCCC-9988776655";
    const tracePath = join(dir, "trace.zip");
    // Bearer lives in a .trace action log line, never in the structured .network headers.
    const traceLog = `{"type":"action","log":["Authorization: Bearer ${token}"]}`;
    await writeFile(
      tracePath,
      makeStoredZip([
        { name: "0-trace.network", data: '{"headers":[]}' },
        { name: "0-trace.trace", data: traceLog }
      ])
    );
    await redactTraceZip(tracePath, []);
    const buf = await readFile(tracePath);
    // Decode every entry and assert the token is gone.
    const entries = decodeZip(buf, zlib);
    for (const entry of entries) {
      assert(!entry.data.includes(Buffer.from(token)), `${entry.name} leaked the bearer token`);
    }
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

function decodeZip(buf, zlib) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  assert(eocd >= 0);
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString("utf8", off + 46, off + 46 + nameLen);
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const comp = buf.subarray(dataStart, dataStart + compSize);
    const data = method === 0 ? Buffer.from(comp) : zlib.inflateRawSync(comp);
    entries.push({ name, data });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}
