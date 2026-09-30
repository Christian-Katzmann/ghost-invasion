// Evidence redaction — keep Ghost's own auth secrets out of the binary artifacts
// (`network.har`, `trace.zip`) that CI uploads and the dashboard serves.
//
// Authenticated drones load a Playwright `storageState`, so the browser sends the
// operator's live `Cookie`/`Authorization` headers on every request. Playwright
// records those verbatim into the HAR (plaintext JSON) and the trace (a deflated
// zip of newline-delimited JSON). This module strips them after capture, before the
// artifact is final on disk.
//
// Two complementary passes, because a secret can land outside a header structure
// (e.g. mirrored into a trace action log):
//   1. Structural — redact any header/cookie whose name is auth-bearing.
//   2. Value-based — replace known secret *values* (the storageState cookies, plus
//      any auth-header values harvested in pass 1) wherever they appear.
//
// Target-owned response bodies (`response-body.json`, S-014) are a separate concern:
// that data belongs to the system under test, not to Ghost. We cannot enumerate it,
// so it is documented as possibly target-owned and minimized at the write site; this
// module only scrubs Ghost's own secrets from it.

import { deflateRawSync, inflateRawSync } from "node:zlib";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Header names whose values are auth-bearing and must never survive into evidence. */
export const SENSITIVE_HEADER_NAMES: ReadonlySet<string> = new Set([
  "cookie",
  "set-cookie",
  "authorization",
  "proxy-authorization",
  "x-api-key",
  "x-auth-token",
  "x-session-token",
  "x-csrf-token",
  "x-xsrf-token"
]);

export const REDACTED = "<ghost-redacted>";

// Value-based replacement only fires for values long enough to be a real secret —
// short values ("1", "en") would corrupt unrelated evidence if blanket-replaced.
const MIN_SECRET_VALUE_LENGTH = 4;

// Bearer tokens can ride in an auth channel we never see as a structured header —
// app-injected `Authorization: Bearer <jwt>` mirrored into a response body or a trace
// action log (S-002). Harvest the token text wherever it appears so the value-based
// pass scrubs it from every sibling artifact, not just the one it was found in.
const BEARER_TOKEN_PATTERN = /\bBearer\s+([A-Za-z0-9._~+/=-]{8,})/gi;

function harvestBearerTokens(text: string, harvested: Set<string>): void {
  for (const match of text.matchAll(BEARER_TOKEN_PATTERN)) {
    const token = match[1];
    if (token && token.length >= MIN_SECRET_VALUE_LENGTH) harvested.add(token);
  }
}

// Write redacted content through a sibling temp file + atomic rename (F7). Playwright
// flushes the raw artifact to the canonical path; rewriting it in place would expose a
// truncated/torn file to a concurrent reader (the live dashboard) mid-write. A rename
// on the same directory is atomic, so the canonical path flips from the complete raw
// file straight to the complete redacted one — never a partial state.
async function atomicWrite(path: string, data: string | Buffer): Promise<void> {
  const tmp = `${path}.redacting.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, path);
}

function isSensitiveHeaderName(name: unknown): boolean {
  return typeof name === "string" && SENSITIVE_HEADER_NAMES.has(name.toLowerCase());
}

/**
 * Redact auth headers/cookies in a parsed HAR-shaped object in place, harvesting the
 * original sensitive values so the caller can scrub them from sibling artifacts too.
 */
function redactHarHeadersInPlace(har: unknown, harvested: Set<string>): void {
  const entries = (har as { log?: { entries?: unknown[] } } | undefined)?.log?.entries;
  if (!Array.isArray(entries)) return;
  for (const entry of entries) {
    for (const side of ["request", "response"] as const) {
      const message = (entry as Record<string, unknown>)?.[side];
      if (!message || typeof message !== "object") continue;
      const record = message as Record<string, unknown>;
      redactHeaderList(record.headers, harvested);
      redactCookieList(record.cookies, harvested);
    }
  }
}

function redactHeaderList(headers: unknown, harvested: Set<string>): void {
  if (!Array.isArray(headers)) return;
  for (const header of headers) {
    if (header && typeof header === "object" && isSensitiveHeaderName((header as Record<string, unknown>).name)) {
      const original = (header as Record<string, unknown>).value;
      if (typeof original === "string" && original.length >= MIN_SECRET_VALUE_LENGTH) harvested.add(original);
      (header as Record<string, unknown>).value = REDACTED;
    }
  }
}

function redactCookieList(cookies: unknown, harvested: Set<string>): void {
  if (!Array.isArray(cookies)) return;
  for (const cookie of cookies) {
    if (cookie && typeof cookie === "object") {
      const original = (cookie as Record<string, unknown>).value;
      if (typeof original === "string" && original.length >= MIN_SECRET_VALUE_LENGTH) harvested.add(original);
      (cookie as Record<string, unknown>).value = REDACTED;
    }
  }
}

/** Replace every occurrence of each secret value in `text` with the redaction marker. */
function scrubValues(text: string, secrets: Iterable<string>): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length < MIN_SECRET_VALUE_LENGTH) continue;
    if (out.includes(secret)) out = out.split(secret).join(REDACTED);
  }
  return out;
}

/** Read the cookie (and token-like localStorage) values from a Playwright storageState file. */
export async function collectStorageStateSecrets(storageStatePath: string | undefined | null): Promise<string[]> {
  if (!storageStatePath) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(storageStatePath, "utf8"));
  } catch {
    return [];
  }
  const secrets = new Set<string>();
  const cookies = (parsed as { cookies?: unknown }).cookies;
  if (Array.isArray(cookies)) {
    for (const cookie of cookies) {
      const value = (cookie as Record<string, unknown>)?.value;
      if (typeof value === "string" && value.length >= MIN_SECRET_VALUE_LENGTH) secrets.add(value);
    }
  }
  const origins = (parsed as { origins?: unknown }).origins;
  if (Array.isArray(origins)) {
    for (const origin of origins) {
      const items = (origin as Record<string, unknown>)?.localStorage;
      if (!Array.isArray(items)) continue;
      for (const item of items) {
        const name = String((item as Record<string, unknown>)?.name ?? "");
        const value = (item as Record<string, unknown>)?.value;
        if (typeof value !== "string" || value.length < MIN_SECRET_VALUE_LENGTH) continue;
        if (/token|auth|session|secret|key|jwt|bearer/i.test(name)) secrets.add(value);
      }
    }
  }
  return [...secrets];
}

/** Redact a HAR file in place. Returns the harvested secret values for sibling scrubbing. */
export async function redactHarFile(path: string, knownSecrets: Iterable<string> = []): Promise<string[]> {
  const raw = await readFile(path, "utf8");
  const harvested = new Set<string>(knownSecrets);
  let har: unknown;
  try {
    har = JSON.parse(raw);
  } catch {
    // Unparseable HAR: scrub known values and bail rather than risk leaking structure we
    // cannot reason about.
    harvestBearerTokens(raw, harvested);
    await atomicWrite(path, scrubValues(raw, harvested));
    return [...harvested];
  }
  redactHarHeadersInPlace(har, harvested);
  const serialized = JSON.stringify(har, null, 2);
  harvestBearerTokens(serialized, harvested);
  const text = scrubValues(serialized, harvested);
  await atomicWrite(path, text);
  return [...harvested];
}

// --- Minimal zip codec (read + rewrite) -------------------------------------------
// A Playwright trace is a standard zip of deflated entries. We own this rather than
// reaching into Playwright internals so the redaction path stays stable across
// Playwright bumps and is unit-testable in isolation. Only what the trace needs:
// store/deflate (method 0/8), no zip64, no data descriptors on write.

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

interface ZipEntry {
  name: string;
  data: Buffer;
}

function readZipEntries(buf: Buffer): ZipEntry[] {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("trace.zip: end-of-central-directory not found");
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error("trace.zip: bad central directory header");
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString("utf8", off + 46, off + 46 + nameLen);
    if (buf.readUInt32LE(localOff) !== 0x04034b50) throw new Error("trace.zip: bad local file header");
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const comp = buf.subarray(dataStart, dataStart + compSize);
    const data = method === 0 ? Buffer.from(comp) : inflateRawSync(comp);
    entries.push({ name, data });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function writeZipEntries(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, "utf8");
    const comp = deflateRawSync(entry.data);
    const crc = crc32(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(8, 8); // method: deflate
    local.writeUInt16LE(0, 10); // mod time
    local.writeUInt16LE(0x21, 12); // mod date (fixed, deterministic)
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra len
    locals.push(local, nameBuf, comp);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 8); // flags
    central.writeUInt16LE(8, 10); // method
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + comp.length;
  }
  const localPart = Buffer.concat(locals);
  const centralPart = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralPart.length, 12);
  eocd.writeUInt32LE(localPart.length, 16);
  return Buffer.concat([localPart, centralPart, eocd]);
}

// A zip entry is treated as text (and structurally/string-redacted) when it is one of
// the trace's JSON streams; everything else (screenshots, raw resource blobs) is only
// byte-scrubbed for known secret values and otherwise passes through untouched.
function isTextTraceEntry(name: string): boolean {
  return name.endsWith(".trace") || name.endsWith(".network") || name.endsWith(".stacks") || name.endsWith(".json");
}

/** Redact a Playwright trace.zip in place. Returns the harvested secret values. */
export async function redactTraceZip(path: string, knownSecrets: Iterable<string> = []): Promise<string[]> {
  const buf = await readFile(path);
  const entries = readZipEntries(buf);
  const harvested = new Set<string>(knownSecrets);

  // Pass 1: structurally redact the network stream (one JSON object per line) and
  // harvest the auth values it carried.
  for (const entry of entries) {
    if (!entry.name.endsWith(".network")) continue;
    entry.data = Buffer.from(redactNetworkNdjson(entry.data.toString("utf8"), harvested), "utf8");
  }

  // Pass 1b: harvest bearer tokens carried in text streams (action logs, bodies) that
  // never surfaced as a structured header, so pass 2 scrubs them everywhere (S-002).
  for (const entry of entries) {
    if (isTextTraceEntry(entry.name)) harvestBearerTokens(entry.data.toString("utf8"), harvested);
  }

  // Pass 2: scrub every harvested + known value across all text entries.
  for (const entry of entries) {
    if (!isTextTraceEntry(entry.name)) {
      // Binary resource: only rewrite if it literally contains a known secret.
      if (![...harvested].some((s) => entry.data.includes(s))) continue;
    }
    const scrubbed = scrubValues(entry.data.toString("utf8"), harvested);
    entry.data = Buffer.from(scrubbed, "utf8");
  }

  await atomicWrite(path, writeZipEntries(entries));
  return [...harvested];
}

function redactNetworkNdjson(text: string, harvested: Set<string>): string {
  return text
    .split("\n")
    .map((line) => {
      if (!line.trim()) return line;
      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch {
        return line;
      }
      redactNetworkEventInPlace(event, harvested);
      return JSON.stringify(event);
    })
    .join("\n");
}

function redactNetworkEventInPlace(node: unknown, harvested: Set<string>): void {
  if (Array.isArray(node)) {
    // A header array is [{name, value}, ...]; redact in place, else recurse.
    for (const item of node) {
      if (item && typeof item === "object" && isSensitiveHeaderName((item as Record<string, unknown>).name)) {
        const original = (item as Record<string, unknown>).value;
        if (typeof original === "string" && original.length >= MIN_SECRET_VALUE_LENGTH) harvested.add(original);
        (item as Record<string, unknown>).value = REDACTED;
      } else {
        redactNetworkEventInPlace(item, harvested);
      }
    }
    return;
  }
  if (node && typeof node === "object") {
    for (const value of Object.values(node as Record<string, unknown>)) redactNetworkEventInPlace(value, harvested);
  }
}

export interface DroneRedactionResult {
  har: boolean;
  trace: boolean;
  responseBody: boolean;
  deleted: string[];
}

/**
 * Scrub Ghost's own auth secrets from every secret-bearing artifact in a drone
 * directory. Fail-closed: if an artifact cannot be redacted it is deleted rather than
 * left to leak.
 */
export async function redactDroneEvidence(options: {
  droneDir: string;
  storageStatePath?: string | null;
}): Promise<DroneRedactionResult> {
  const secrets = await collectStorageStateSecrets(options.storageStatePath);
  const result: DroneRedactionResult = { har: false, trace: false, responseBody: false, deleted: [] };

  const harPath = join(options.droneDir, "network.har");
  let harvested: string[] = secrets;
  if (await fileExists(harPath)) {
    try {
      harvested = await redactHarFile(harPath, secrets);
      result.har = true;
    } catch {
      await rm(harPath, { force: true });
      result.deleted.push(harPath);
    }
  }

  const tracePath = join(options.droneDir, "trace.zip");
  if (await fileExists(tracePath)) {
    try {
      await redactTraceZip(tracePath, harvested);
      result.trace = true;
    } catch {
      await rm(tracePath, { force: true });
      result.deleted.push(tracePath);
    }
  }

  // response-body.json holds target-owned data; scrub only Ghost's own secrets from it.
  // It is also the most likely place a non-cookie/non-header auth channel surfaces, so
  // harvest bearer tokens from the body itself before scrubbing (S-002).
  const responseBodyPath = join(options.droneDir, "response-body.json");
  if (await fileExists(responseBodyPath)) {
    try {
      const raw = await readFile(responseBodyPath, "utf8");
      const secrets = new Set(harvested);
      harvestBearerTokens(raw, secrets);
      const scrubbed = scrubValues(raw, secrets);
      if (scrubbed !== raw) {
        await atomicWrite(responseBodyPath, scrubbed);
        result.responseBody = true;
      }
    } catch {
      // Leave the file; it carries target data, not Ghost secrets, and the write site
      // already minimizes + labels it.
    }
  }

  return result;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}
