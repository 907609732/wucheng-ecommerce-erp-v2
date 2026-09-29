import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { terminateProcessTree } from "../desktop/shared/task-process.mjs";
import { mergeScheduledTasks, queueAfterTaskResult } from "../desktop/shared/task-schedule.mjs";

test("terminateProcessTree stops a real long-running child process", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    windowsHide: true,
    stdio: "ignore"
  });
  await new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });

  const result = await terminateProcessTree(child);
  assert.equal(result.stopped, true);
  await new Promise((resolve) => child.exitCode !== null ? resolve() : child.once("close", resolve));
  assert.notEqual(child.exitCode, null);
});

test("terminateProcessTree is idempotent when no process is running", async () => {
  assert.deepEqual(await terminateProcessTree(null), { stopped: false, reason: "not-running" });
});

test("scheduled inventory runs before monthly sales and duplicate tasks are removed", () => {
  const tasks = mergeScheduledTasks(
    [{ kind: "monthly-sales", options: { month: "2026-08" } }],
    [{ kind: "sync", options: {} }, { kind: "monthly-sales", options: { month: "2026-08" } }]
  );
  assert.deepEqual(tasks.map((item) => item.kind), ["sync", "monthly-sales"]);
  assert.equal(queueAfterTaskResult(tasks, { success: false }).length, 0);
  assert.equal(queueAfterTaskResult(tasks, { success: true, cancelled: false }).length, 2);
});
