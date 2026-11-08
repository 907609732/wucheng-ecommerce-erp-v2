import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  snapshotData,
  verifySnapshot,
  restoreSnapshot,
} from "../server/backup.mjs";
test("backup restores all three databases and attachments without changing source; corruption fails closed", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "web-backup-"));
  try {
    const modules = {};
    for (const id of ["purchase", "sales", "overview"]) {
      const dataDir = path.join(dir, "source", id);
      fs.mkdirSync(path.join(dataDir, "originals"), { recursive: true });
      const file = id === "purchase" ? "purchases.sqlite" : id + ".sqlite";
      const db = new DatabaseSync(path.join(dataDir, file));
      db.exec(
        "CREATE TABLE ledger(amount INTEGER); INSERT INTO ledger VALUES(12345)",
      );
      db.close();
      fs.writeFileSync(path.join(dataDir, "originals", "bill.txt"), "evidence");
      modules[id] = { dataDir };
    }
    const output = path.join(dir, "backup");
    const stateDir = path.join(dir, "state");
    fs.mkdirSync(path.join(stateDir, "month-admin"), { recursive: true });
    const credential = new DatabaseSync(path.join(stateDir, "month-admin", "month-admin.sqlite"));
    credential.exec("PRAGMA journal_mode=WAL; CREATE TABLE credentials(value TEXT); INSERT INTO credentials VALUES('hashed-password-record')");
    await snapshotData({ modules, stateDir }, output);
    credential.close();
    assert.equal(verifySnapshot(output).ok, true);
    const restored = path.join(dir, "restored");
    restoreSnapshot(output, restored);
    const restoredCredential = new DatabaseSync(path.join(restored, "month-admin", "month-admin.sqlite"), { readOnly: true });
    assert.equal(restoredCredential.prepare("SELECT value FROM credentials").get().value, "hashed-password-record");
    restoredCredential.close();
    assert.equal(
      fs.readFileSync(
        path.join(restored, "sales", "originals", "bill.txt"),
        "utf8",
      ),
      "evidence",
    );
    const db = new DatabaseSync(path.join(restored, "sales", "sales.sqlite"), {
      readOnly: true,
    });
    assert.equal(db.prepare("SELECT amount FROM ledger").get().amount, 12345);
    db.close();
    assert.throws(() => restoreSnapshot(output, restored), /存在/);
    fs.writeFileSync(
      path.join(output, "sales", "originals", "bill.txt"),
      "broken",
    );
    assert.throws(() => verifySnapshot(output), /校验/);
    assert.throws(() => restoreSnapshot(output, path.join(dir, "bad")), /校验/);
    assert(!fs.existsSync(path.join(dir, "bad")));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
