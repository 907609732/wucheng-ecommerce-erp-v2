const path=require('node:path');
const root=path.resolve(__dirname,'..');
module.exports={
  appId:'com.wucheng.ecommerce.erp.v2',
  productName:'云仓库存同步',
  electronVersion:'44.4.5',
  electronDist:path.join(root,'node_modules/electron/dist'),
  directories:{output:path.join(root,'dist/launcher-release')},
  files:['desktop/**/*','package.json'],
  artifactName:'CloudWarehouseInventorySync-Setup-${version}-${arch}.${ext}',
  publish:[{provider:'github',owner:'907609732',repo:'wucheng-ecommerce-erp-v2',private:false,releaseType:'release'}],
  npmRebuild:false,asar:true,
  win:{icon:path.join(root,'desktop/assets/lingtu-icon.png'),target:[{target:'nsis',arch:['x64']},{target:'portable',arch:['x64']}]},
  nsis:{oneClick:false,allowToChangeInstallationDirectory:true,createDesktopShortcut:true,createStartMenuShortcut:true,shortcutName:'云仓库存同步',deleteAppDataOnUninstall:false},
  portable:{artifactName:'CloudWarehouseInventorySync-Portable-${version}-${arch}.${ext}'}
};
