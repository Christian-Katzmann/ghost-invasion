import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EvidenceBus } from "../dist/evidence.js";

async function withBus(fn) {
  const root = await mkdtemp(join(tmpdir(), "ghost-evidence-"));
  const bus = new EvidenceBus({ projectRoot: root, runId: "evidence-test-run" });
  await bus.init();
  try {
    return await fn(bus);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function readEventTypes(bus) {
  const content = await readFile(bus.eventsPath, "utf8");
  return content
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line).type);
}

test("append writes every event to the spine in order", async () => {
  await withBus(async (bus) => {
    await bus.append({ type: "first" });
    await bus.append({ type: "second" });
    await bus.flush();

    assert.deepEqual(await readEventTypes(bus), ["first", "second"]);
    assert.equal(bus.summary().degraded, false);
  });
});

test("a single appendFile failure does not poison the queue and is recorded", async () => {
  await withBus(async (bus) => {
    // Fault-inject one rejected write through the overridable spine seam.
    const realWrite = EvidenceBus.prototype.appendToEventsFile.bind(bus);
    let alreadyFailed = false;
    bus.appendToEventsFile = async (line) => {
      if (!alreadyFailed) {
        alreadyFailed = true;
        throw new Error("ENOSPC: simulated full disk");
      }
      return realWrite(line);
    };

    // The poisoned write rejects to its own caller...
    await assert.rejects(bus.append({ type: "first" }), /ENOSPC/);
    // ...but later appends must still attempt and land.
    await bus.append({ type: "second" });
    await bus.append({ type: "third" });
    await bus.flush();

    const types = await readEventTypes(bus);
    assert.ok(types.includes("second"), "later append must still land");
    assert.ok(types.includes("third"), "later append must still land");
    assert.ok(
      types.includes("evidence-write-degraded"),
      "a terminal degraded marker must be recorded"
    );
    // The dropped event never silently passes as written.
    assert.ok(!types.includes("first"), "the failed write must not appear written");
    assert.equal(bus.summary().degraded, true, "summary surfaces the degraded flag");
  });
});

test("the degraded marker is recorded only once across repeated failures", async () => {
  await withBus(async (bus) => {
    const realWrite = EvidenceBus.prototype.appendToEventsFile.bind(bus);
    bus.appendToEventsFile = async (line) => {
      // Every primary event write fails; only the marker write is allowed through.
      const parsed = JSON.parse(line);
      if (parsed.type === "evidence-write-degraded") {
        return realWrite(line);
      }
      throw new Error("EISDIR: simulated bad target");
    };

    await assert.rejects(bus.append({ type: "first" }));
    await assert.rejects(bus.append({ type: "second" }));
    await bus.flush();

    const markers = (await readEventTypes(bus)).filter((t) => t === "evidence-write-degraded");
    assert.equal(markers.length, 1, "exactly one terminal degraded marker");
    assert.equal(bus.summary().degraded, true);
  });
});
