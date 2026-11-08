import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { prepareRelease, verifyRelease } from "../server/release.mjs";
test("release exports only web source and never marks an untested directory accepted", async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "web-release-")),
    dir = path.join(parent, "candidate");
  try {
    const r = await prepareRelease(dir, { install: false });
    assert.equal(r.accepted, false);
    assert(!fs.existsSync(path.join(dir, "core")));
    assert(!fs.existsSync(path.join(dir, "desktop", "launcher")));
    assert(fs.existsSync(path.join(dir, "apps", "sales", "server.mjs")));
    assert(fs.existsSync(path.join(dir, "ui", "period-picker.mjs")));
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json")));
    assert(!pkg.dependencies.electron);
    assert.deepEqual(Object.keys(pkg.dependencies).sort(),['@fastify/cookie','@fastify/http-proxy','@fastify/reply-from','fastify','ws']);
    assert.equal(pkg.dependencies['@fastify/http-proxy'],'11.6.4');
    assert.throws(() => verifyRelease(dir), /验收/);
    const f = path.join(dir, "web-release.json"),
      m = JSON.parse(fs.readFileSync(f));
    m.accepted = true;
    m.acceptance = { ok: true, scope: "synthetic-local" };
    fs.writeFileSync(f, JSON.stringify(m));
    verifyRelease(dir);
    fs.appendFileSync(path.join(dir, "server", "cli.mjs"), "\n// changed");
    assert.throws(() => verifyRelease(dir), /变化/);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});
