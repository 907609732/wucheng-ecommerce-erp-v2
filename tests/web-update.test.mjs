import test from "node:test";
import assert from "node:assert/strict";
import { switchRelease } from "../server/update.mjs";
test("update drains, backs up, switches, checks health and rolls program back on failure", async () => {
  const events = [];
  const old = { release: "old" },
    candidate = { release: "new" };
  let current = old;
  await assert.rejects(
    switchRelease({
      current: old,
      candidate,
      check: async (c) => events.push("check-" + c.release),
      stop: async () => events.push("stop"),
      snapshot: async () => events.push("backup"),
      write: async (c) => {
        current = c;
        events.push("write-" + c.release);
      },
      start: async (c) => events.push("start-" + c.release),
      health: async (c) => {
        events.push("health-" + c.release);
        if (c === candidate) throw Error("bad candidate");
      },
    }),
    /已回退/,
  );
  assert.equal(current, old);
  assert.deepEqual(events, [
    "check-new",
    "stop",
    "backup",
    "write-new",
    "start-new",
    "health-new",
    "stop",
    "write-old",
    "start-old",
    "health-old",
  ]);
});
test("busy shutdown or backup failure never switches release", async () => {
  let writes = 0;
  const base = {
    current: {},
    candidate: {},
    check: async () => {},
    stop: async () => {},
    snapshot: async () => {},
    write: async () => writes++,
    start: async () => {},
    health: async () => {},
  };
  await assert.rejects(
    switchRelease({
      ...base,
      stop: async () => {
        throw Error("busy");
      },
    }),
    /busy/,
  );
  assert.equal(writes, 0);
  await assert.rejects(
    switchRelease({
      ...base,
      snapshot: async () => {
        throw Error("backup failure");
      },
    }),
    /备份/,
  );
  assert.equal(writes, 0);
  await assert.rejects(
    switchRelease({
      ...base,
      preflight: async () => {
        throw Error("incompatible copy");
      },
    }),
    /副本/,
  );
  assert.equal(writes, 0);
});
