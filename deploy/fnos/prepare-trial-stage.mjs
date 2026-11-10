import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

export function prepareTrialStage(main, trial) {
  if (fs.existsSync(trial)) throw Error('Trial stage must be a new path');
  fs.cpSync(main, trial, {recursive:true, errorOnExist:true, force:false, verbatimSymlinks:true});
  const manifest=path.join(trial,'manifest');
  fs.writeFileSync(manifest,fs.readFileSync(manifest,'utf8').replaceAll('wuchengerp','wuchengerptrial').replaceAll('五成ERP','五成ERP（隔离验收）'));
  const ui=path.join(trial,'app/ui/config'), config=JSON.parse(fs.readFileSync(ui,'utf8'));
  const entry=config['.url']['wuchengerp.main'];
  if(!entry) throw Error('Main desktop entry missing');
  delete config['.url']['wuchengerp.main'];
  config['.url']['wuchengerptrial.main']={...entry,title:'五成ERP（隔离验收）',gatewayPrefix:'/app/wuchengerptrial',gatewaySocket:'app.sock',url:'/app/wuchengerptrial/'};
  fs.writeFileSync(ui,JSON.stringify(config,null,2)+'\n');
  const hook=path.join(trial,'cmd/native_env'); let text=fs.readFileSync(hook,'utf8');
  const base='BASE="$VOLUME/@wuchengerp-data"'; if(text.split(base).length!==2) throw Error('Trial data base source marker mismatch');
  text=text.replace('#!/bin/sh\n','#!/bin/sh\nERP_NATIVE_BASE_PREFIX=/app/wuchengerptrial\nexport ERP_NATIVE_BASE_PREFIX\n').replace(base,'BASE="$VOLUME/@wuchengerptrial-data"');
  const failMarker='}\n[ -n "${TRIM_APPDEST_VOL:-}" ]';
  if(!text.includes(failMarker)) throw Error('Trial migration guard insertion marker mismatch');
  text=text.replace(failMarker,"}\n[ \"${erp_mode:-}\" != migrate ] || fail '隔离试装禁止迁移正式或其他实例数据。'\n[ -n \"${TRIM_APPDEST_VOL:-}\" ]");
  fs.writeFileSync(hook,text);
  for(const name of ['install_callback','upgrade_callback']) {
    const p=path.join(trial,'cmd',name); text=fs.readFileSync(p,'utf8');
    const marker='. "$SELF/native_env"\n'; if(!text.includes(marker)) throw Error(`Missing ${name} native env marker`);
    text=text.replace(marker,marker+"[ \"${erp_mode:-}\" != migrate ] || fail '隔离试装禁止迁移正式或其他实例数据。'\n");
    if(name==='install_callback'){
      const configure='if ! as_package "$NODE" "$LIFECYCLE" configure;';
      if(!text.includes(configure)) throw Error('Missing trial install configure marker');
      text=text.slice(0,text.indexOf(configure))+[
        'if ! configure_error=$(as_package "$NODE" "$LIFECYCLE" configure 2>&1); then',
        ' detail=$(printf "%s" "$configure_error" | tail -c 2048 | tr -d "\\000-\\010\\013-\\037\\177")',
        ' fail "ERP 初始化失败（隔离试装）：$detail"',
        'fi',
        '',
      ].join('\n');
    }
    fs.writeFileSync(p,text);
  }
  const recovery=path.join(trial,'cmd/retained_recovery.py'); text=fs.readFileSync(recovery,'utf8');
  const old="'@wuchengerp-data'"; if(text.split(old).length!==3) throw Error('Trial recovery data base source markers mismatch');
  fs.writeFileSync(recovery,text.replaceAll(old,"'@wuchengerptrial-data'"));
  const thirdParty=path.join(trial,'app/THIRD-PARTY.json');
  if(fs.existsSync(thirdParty)) {
    const info=JSON.parse(fs.readFileSync(thirdParty,'utf8'));
    info.packageName='wuchengerptrial';
    if(info.xvfbBuild){info.xvfbBuild.xkbBinDir='/var/apps/wuchengerptrial/target/runtime/sysroot/usr/bin';info.xvfbBuild.xkbDir='/var/apps/wuchengerptrial/target/runtime/sysroot/usr/share/X11/xkb';}
    fs.writeFileSync(thirdParty,JSON.stringify(info,null,2)+'\n');
  }
  fs.writeFileSync(path.join(trial,'wizard/install'),`[\n {"stepTitle":"初始化五成ERP（隔离验收）","items":[\n  {"type":"tips","helpText":"这是隔离验收实例，只能新建合成账本或沿用本试装自身数据。禁止从正式ERP、Docker或其他账本迁移。数据独立保存在安装卷 @wuchengerptrial-data/erp。"},\n  {"type":"select","field":"erp_mode","label":"试装数据方式","options":[{"label":"新建三个合成账本","value":"fresh"},{"label":"沿用本试装数据","value":"existing"}],"rules":[{"required":true,"message":"请选择试装数据方式"}]},\n  {"type":"text","field":"erp_origin","label":"主飞牛中继 HTTPS 地址（新建必填，含端口）"},\n  {"type":"text","field":"erp_origins","label":"飞牛允许源（新建必填，逗号分隔）"},\n  {"type":"tips","helpText":"由飞牛系统设置中的「桌面访问」决定谁能打开隔离版。"},\n  {"type":"select","field":"wizard_uvcs_install","label":"系统 UVCS","initValue":"0","options":[{"label":"不安装","value":"0"},{"label":"从官方源安装系统 UVCS CLI","value":"1"}]}\n ]}\n]\n`);
  for (const file of ['upgrade','uninstall','config']) {
    const p=path.join(trial,'wizard',file); text=fs.readFileSync(p,'utf8').replaceAll('wuchengerp-data','wuchengerptrial-data');
    if(file==='upgrade') text=text.replace('沿用已安装原生数据','沿用本试装数据').replace('从旧薄入口迁移停写副本','不可迁移');
    if(file==='upgrade') { const parsed=JSON.parse(text); for(const page of parsed) for(const item of page.items||[]) if(item.options) item.options=item.options.filter(option=>option.value!=='migrate'); text=JSON.stringify(parsed,null,2)+'\n'; }
    fs.writeFileSync(p,text);
  }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) prepareTrialStage(process.argv[2],process.argv[3]);
