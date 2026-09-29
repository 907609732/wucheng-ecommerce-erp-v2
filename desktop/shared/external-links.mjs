export const EXTERNAL_LINKS = Object.freeze({
  repository: "https://github.com/907609732/wucheng-ecommerce-erp-v2"
});

export function externalLink(name) {
  const url = EXTERNAL_LINKS[String(name || "")];
  if (!url) throw new Error("不允许打开未知外部链接");
  return url;
}
