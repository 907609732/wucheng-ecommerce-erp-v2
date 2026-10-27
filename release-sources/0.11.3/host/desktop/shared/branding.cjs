const BASE_PRODUCT_NAME = "云仓库存同步";

function normalizeBuildChannel(value) {
  const channel = String(value || "").trim().toLowerCase();
  if (["release", "stable", "production"].includes(channel)) return "release";
  if (["beta", "test", "development"].includes(channel)) return channel;
  return "development";
}

function buildBranding(channelValue) {
  const channel = normalizeBuildChannel(channelValue);
  const official = channel === "release";
  return {
    channel,
    official,
    productName: official ? BASE_PRODUCT_NAME : `${BASE_PRODUCT_NAME}（测试版）`,
    artifactMarker: official ? "" : "-Test"
  };
}

module.exports = { BASE_PRODUCT_NAME, normalizeBuildChannel, buildBranding };
