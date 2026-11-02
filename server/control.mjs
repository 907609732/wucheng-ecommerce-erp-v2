import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { createHash } from "node:crypto";
export function controlEndpoint(stateDir) {
  const key = createHash("sha256")
    .update(path.resolve(stateDir).toLowerCase())
    .digest("hex")
    .slice(0, 32);
  return process.platform === "win32"
    ? "\\\\.\\pipe\\wucheng-web-" + key
    : path.join(stateDir, "web.sock");
}
export async function control(stateDir, action) {
  const { token } = JSON.parse(
    fs.readFileSync(path.join(stateDir, "web-control.json"), "utf8"),
  );
  return new Promise((resolve, reject) => {
    let buffer = "";
    const s = net.createConnection(controlEndpoint(stateDir));
    s.setTimeout(70000, () => s.destroy(Error("主机维护操作超时")));
    s.once("error", reject);
    s.once("connect", () => s.write(JSON.stringify({ token, action }) + "\n"));
    s.on("data", (chunk) => {
      buffer += chunk;
      if (buffer.includes("\n")) {
        try {
          const r = JSON.parse(buffer.split("\n")[0]);
          s.end();
          if (r.ok) resolve(r);
          else reject(Error(r.error));
        } catch (e) {
          reject(e);
          s.destroy();
        }
      }
    });
    s.once("end", () => {
      if (!buffer) reject(Error("主机控制连接已关闭"));
    });
  });
}
