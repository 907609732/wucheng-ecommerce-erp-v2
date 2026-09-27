module.exports = {
  appId: "com.wucheng.ecommerce.erp.v2",
  productName: "五成电子商务集团 ERP V2",
  publish: [{
    provider: "github",
    owner: "907609732",
    repo: "wucheng-ecommerce-erp-v2",
    private: true,
    releaseType: "release"
  }],
  artifactName: "WuchengERP-V2-Setup-${version}-${arch}.${ext}",
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
    shortcutName: "五成电子商务集团 ERP V2",
    deleteAppDataOnUninstall: false
  },
  portable: {
    artifactName: "WuchengERP-V2-Portable-${version}-${arch}.${ext}"
  }
};
