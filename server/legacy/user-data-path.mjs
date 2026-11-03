import path from "node:path";

export const USER_DATA_DIRECTORY_NAME = "wucheng-ecommerce-erp-v2";

export function canonicalUserDataPath(appDataPath) {
  return path.join(String(appDataPath || ""), USER_DATA_DIRECTORY_NAME);
}

export function requestedUserDataPath(args = []) {
  for (let index = 0; index < args.length; index += 1) {
    const value = String(args[index] || "");
    if (value.startsWith("--user-data-dir=")) return path.resolve(value.slice("--user-data-dir=".length));
    if (value === "--user-data-dir" && args[index + 1]) return path.resolve(String(args[index + 1]));
  }
  return "";
}
