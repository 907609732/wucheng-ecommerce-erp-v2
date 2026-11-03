import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { acceptSource } from "./acceptance.mjs";
/** New and old programs must both read the migrated copy with equal results. */
export async function validateUpgrade(currentRoot, candidateRoot, backupRoot) {
  let migrated;
  try {
    const before = await acceptSource(currentRoot, { dataRoot: backupRoot });
    const candidate = await acceptSource(candidateRoot, {
      dataRoot: backupRoot,
      keepData: true,
    });
    migrated = path.dirname(candidate.dataCopy);
    const rollback = await acceptSource(currentRoot, {
      dataRoot: candidate.dataCopy,
    });
    for (const [i, row] of before.services.entries())
      if (
        row.queryDigest !== candidate.services[i].queryDigest ||
        row.queryDigest !== rollback.services[i].queryDigest
      )
        throw Error(row.id + " 关键业务查询与旧版本不同，需要单独审查后迁移");
    return {
      ok: true,
      scope: "isolated-upgrade-and-rollback",
      modules: before.services.map((x) => x.id),
    };
  } finally {
    if (
      migrated &&
      path.dirname(path.resolve(migrated)) === path.resolve(os.tmpdir()) &&
      path.basename(migrated).startsWith("wucheng-web-acceptance-") &&
      !fs.lstatSync(migrated).isSymbolicLink()
    )
      fs.rmSync(migrated, { recursive: true, force: true });
  }
}
