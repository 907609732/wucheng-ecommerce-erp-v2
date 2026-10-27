export function decryptedText(value) {
  if (typeof value === "string") return value;
  if (value && typeof value.result === "string") return value.result;
  throw new Error("Windows 安全存储返回了无法识别的解密结果");
}
