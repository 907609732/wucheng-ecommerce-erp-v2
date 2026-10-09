const fs = require("node:fs");
const path = require("node:path");
const { buildBranding } = require("../desktop/shared/branding.cjs");

function preparedChannel() {
  try {
    return JSON.parse(fs.readFileSync(path.resolve("build", "private", "build-info.json"), "utf8")).channel;
  } catch {
    return process.env.CAINIAO_INTERNAL_UPDATE_TOKEN ? "release" : "development";
  }
}

const branding = buildBranding(preparedChannel());

module.exports = {
  appId: "com.wucheng.ecommerce.erp.v2",
  productName: branding.productName,
  publish: [{
    provider: "github",
    owner: "907609732",
    repo: "wucheng-ecommerce-erp-v2",
    private: false,
    releaseType: "release"
  }],
  artifactName: `CloudWarehouseInventorySync${branding.artifactMarker}-Setup-\${version}-\${arch}.\${ext}`,
  directories: {
    output: "dist",
    buildResources: "build"
  },
  files: [
    "desktop/**/*",
    "core/**/*",
    "config.json",
    "package.json"
  ],
  extraResources: [
    { from: "build/private/update-token.txt", to: "update-token.txt" },
    { from: "build/private/build-info.json", to: "build-info.json" }
  ],
  asar: true,
  npmRebuild: false,
  win: {
    target: [
      { target: "nsis", arch: ["x64"] },
      { target: "portable", arch: ["x64"] }
    ]
  },
  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: branding.productName,
    deleteAppDataOnUninstall: false
  },
  portable: {
    artifactName: `CloudWarehouseInventorySync${branding.artifactMarker}-Portable-\${version}-\${arch}.\${ext}`
  }
};
