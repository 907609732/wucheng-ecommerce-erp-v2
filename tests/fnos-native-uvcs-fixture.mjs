import {DatabaseSync} from 'node:sqlite';
import {developmentConfig,databases} from '../server/config.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
export const expected={id:'original-workspace-guid',name:'original-workspace',repository:'repo@organization@cloud'};
export function uvcsFixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'native-uvcs-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const home=path.join(root,'home'),workspace=path.join(root,'data-version','workspace'),stateDir=path.join(root,'state');
 for(const dir of [home,workspace,stateDir,path.join(workspace,'.plastic')])fs.mkdirSync(dir,{recursive:true,mode:0o700});
 fs.writeFileSync(path.join(workspace,'.plastic','plastic.wktree'),'original metadata');
 const script=`const fs=require('fs'),path=require('path');const home=process.env.HOME,workspace=process.cwd(),cmd=path.basename(process.argv[1]),args=process.argv.slice(2),mode=fs.existsSync(path.join(home,'mode'))?fs.readFileSync(path.join(home,'mode'),'utf8'):'';fs.appendFileSync(path.join(path.dirname(home),'children.log'),process.pid+'\\n');fs.appendFileSync(path.join(path.dirname(home),'commands.log'),JSON.stringify([cmd,...args])+'\\n');
 if(mode==='error')process.exit(2);if(mode==='timeout')setInterval(()=>{},1000);else if(cmd==='workspace'){if(args.join('|')!=='list|--format={wkname}{tab}{path}{tab}{wkid}{tab}{wkspec}')process.exit(9);if(fs.existsSync(path.join(home,'registered')))console.log('original-workspace\\t'+workspace+'\\t'+(mode==='wrong-id'?'other-id':'original-workspace-guid')+'\\twk:original-workspace');}
 else if(cmd==='showselector'){if(args.length!==1||args[0]!==workspace)process.exit(9);fs.writeFileSync(path.join(home,'registered'),'registered');if(mode==='metadata-change')fs.appendFileSync(path.join(workspace,'.plastic','plastic.wktree'),'changed');console.log('selector');}
 else if(cmd==='version')console.log('11.0.16.10616');else if(cmd==='fileinfo'){if(args.join('|')!==workspace+'|--format={RepSpec}')process.exit(9);if(mode==='mutate-home')fs.writeFileSync(path.join(home,'refresh'),'refreshed');console.log(mode==='wrong-repo'?'another@cloud':'rep:repo@repserver:organization@cloud');}
 else if(cmd==='find'){if(args[0]!=='changeset'||!args[1].includes("on repository 'repo@organization@cloud'")||args.slice(2).join('|')!=='--format={changesetid}|{date}|--dateformat=yyyy-MM-ddTHH:mm:ss.fffK|--nototal|--encoding=utf-8')process.exit(9);const id=args[1].match(/事件：([^\\]]+)\\]/)[1];if(mode!=='missing'){console.log((mode==='wrong-cs'?'99':id==='event-one'?'7':'8')+'|2026-01-01T01:00:00.000Z');if(mode==='duplicate')console.log('7|2026-01-01T01:00:00.000Z');}}
 else process.exit(9);`;
 for(const cmd of ['workspace','showselector','version','fileinfo','find'])fs.writeFileSync(path.join(workspace,cmd),(process.platform==='win32'?'':'#!'+process.execPath+'\n')+script,{mode:0o755});
 if(process.platform!=='win32'){const oldPath=process.env.PATH;process.env.PATH=workspace+path.delimiter+oldPath;t.after(()=>{process.env.PATH=oldPath;});}
 const c={...developmentConfig({stateDir}),stateDir,native:{dataRoot:root,home,uvcsIdentity:expected},dataVersion:{enabled:true,dir:path.dirname(workspace),workspace,cmPath:process.platform==='win32'?process.execPath:'/usr/bin/env',repository:expected.repository}};
 c.mode='production';c.publicOrigin='https://nas.example.com';c.releaseRoot=path.resolve(import.meta.dirname,'..');
 for(const [id,m]of Object.entries(c.modules)){m.dataDir=path.join(root,'data',id);fs.mkdirSync(m.dataDir,{recursive:true,mode:0o700});const db=new DatabaseSync(path.join(m.dataDir,databases[id]));db.exec('CREATE TABLE fixture(value TEXT)');db.close();}
 for(const name of ['native-lifecycle.sqlite','native-ownership.sqlite']){const db=new DatabaseSync(path.join(stateDir,name));db.exec('CREATE TABLE coordination(value TEXT)');db.close();}
 fs.mkdirSync(path.join(root,'config'));fs.writeFileSync(path.join(root,'config','web.json'),JSON.stringify(c));
 return {root,home,workspace,c,configFile:path.join(root,'config','web.json')};
}
