const path=require('node:path');
const root=path.resolve(__dirname,'..');
const tailnet=require('./tailnet-resource.cjs');
module.exports={
  appId:'com.wucheng.ecommerce.erp.v2',
  productName:'五成电子商务工作台',
  executableName:'云仓库存同步',
  electronVersion:'44.4.5',
  electronDist:path.join(root,'node_modules/electron/dist'),
  directories:{output:path.join(root,'dist/launcher-release')},
  files:['desktop/**/*','package.json','!node_modules/**/{test,tests,__tests__,example,examples,benchmark,benchmarks}/**'],
  artifactName:'CloudWarehouseInventorySync-Setup-${version}-${arch}.${ext}',
  publish:[{provider:'github',owner:'907609732',repo:'wucheng-ecommerce-erp-v2',private:false,releaseType:'release'}],
  npmRebuild:false,asar:true,
  // electron-builder always excludes a matcher's root node_modules directory.
  // Give production dependencies their own matcher so detached Node is complete.
  extraResources:[...(process.env.LINGTU_GATEWAY_RESOURCE?[
    {from:process.env.LINGTU_GATEWAY_RESOURCE,to:'workbench-gateway',filter:['**/*']},
    {from:path.join(process.env.LINGTU_GATEWAY_RESOURCE,'node_modules'),to:'workbench-gateway/node_modules',filter:['**/*','!**/{test,tests,__tests__,examples,benchmark,benchmarks}/**']}
  ]:[]),...(process.env.LINGTU_TAILNET_RESOURCE?[
    {from:process.env.LINGTU_TAILNET_RESOURCE,to:'tailnet-runtime',filter:tailnet.filters}
  ]:[]),...(process.env.LINGTU_SUITE_RESOURCE?[
    {from:process.env.LINGTU_SUITE_RESOURCE,to:'bundled-suite',filter:['*.zip','catalog.json','release-manifest.json']}
  ]:[])],
  afterPack:async ({appOutDir})=>{
    const fs=require('node:fs');
    // Load the actual packaged internal verifier in Node mode. Invalid arguments
    // must reach its narrow protocol guard before any registry or data is read.
    const probe=require('node:child_process').spawnSync(path.join(appOutDir,'云仓库存同步.exe'),[path.join(appOutDir,'resources/app.asar/desktop/workbench-migration/verify-pending-entry.mjs')],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},windowsHide:true,encoding:'utf8',timeout:15000});
    let verifierReceipt;try{verifierReceipt=JSON.parse(probe.stdout);}catch{}
    if(probe.status!==1||verifierReceipt?.protocol!=='lingtu-pending-verification/v1'||verifierReceipt.code!=='INVALID_VERIFICATION_REQUEST')throw Error('Packaged migration verifier entry or production dependencies missing');
    console.log(JSON.stringify({packagedMigrationVerifier:true,nativeNodeModeLoaded:true,noRegistryOrDataRead:true}));
    for(const dependency of ['fastify','@fastify/reply-from','@fastify/cookie']){
      if(!fs.existsSync(path.join(appOutDir,'resources/workbench-gateway/node_modules',dependency,'package.json')))
        throw Error('Packaged gateway dependency missing: '+dependency);
    }
    if(!process.env.LINGTU_TAILNET_RESOURCE)throw Error('Validated Tailnet runtime stage is required');
    const expected=tailnet.validateTailnetResource(process.env.LINGTU_TAILNET_RESOURCE);
    if(process.env.LINGTU_TAILNET_FINGERPRINT!==expected.fingerprint)throw Error('Tailnet runtime stage changed after pre-build validation');
    const packaged=tailnet.validateTailnetResource(path.join(appOutDir,'resources/tailnet-runtime'),{expected});
    tailnet.verifyTailnetVersion(packaged);
    const report=tailnet.probePackagedTailnet({appOutDir,electronPath:path.join(appOutDir,'云仓库存同步.exe'),expected});
    console.log(JSON.stringify({packagedTailnetResources:true,resourceFingerprint:packaged.fingerprint,...report}));
    if(!process.env.LINGTU_SUITE_RESOURCE&&process.env.LINGTU_SHELL_ONLY!=='1')throw Error('The complete business suite is required for distribution');
    if(process.env.LINGTU_SUITE_RESOURCE){
      const {pathToFileURL}=require('node:url');
      const {verifyCatalog,digest}=await import(pathToFileURL(path.join(root,'desktop/modules/package-format.mjs')).href);
      const directory=path.join(appOutDir,'resources/bundled-suite');
      const catalog=verifyCatalog(JSON.parse(fs.readFileSync(path.join(directory,'catalog.json'),'utf8')),JSON.parse(fs.readFileSync(path.join(root,'desktop/launcher/public-keys.json'),'utf8')),{hostVersion:JSON.parse(fs.readFileSync(path.join(root,'desktop/launcher/package.json'),'utf8')).version,platform:'win32',arch:'x64'});
      if(catalog.suite?.format!=='lingtu-suite/v1'||catalog.packages.length!==7)throw Error('Incomplete bundled suite');
      for(const spec of catalog.packages)if(await digest(path.join(directory,spec.archive))!==spec.sha256)throw Error('Packaged suite digest failed: '+spec.id);
      console.log(JSON.stringify({packagedCompleteSuite:true,version:catalog.suite.version,components:catalog.packages.map(({id,version})=>({id,version}))}));
    }
  },
  win:{icon:path.join(root,'desktop/assets/lingtu-icon.png'),target:[{target:'nsis',arch:['x64']}]},
  nsis:{oneClick:false,allowToChangeInstallationDirectory:true,createDesktopShortcut:true,createStartMenuShortcut:true,shortcutName:'五成电子商务工作台',deleteAppDataOnUninstall:false}
};
