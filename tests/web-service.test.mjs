import test from "node:test";
import assert from "node:assert/strict";
import { renderServiceXml } from "../server/service-config.mjs";
test("WinSW configuration uses explicit system Node, graceful IPC stop, recovery and escaped paths", () => {
  const xml = renderServiceXml({
    nodePath: "C:\\Program Files\\nodejs\\node.exe",
    bootstrapPath: "E:\\ERP & Data\\service-host.mjs",
    configFile: "E:\\ERP & Data\\config.json",
    stateDir: "E:\\ERP & Data",
  });
  assert.match(xml, /<stopexecutable>/);
  assert.match(xml, /--stop/);
  assert.match(xml, /<onfailure action="restart"/);
  assert.match(xml, /ERP &amp; Data/);
  assert(!xml.includes("Electron"));
});
