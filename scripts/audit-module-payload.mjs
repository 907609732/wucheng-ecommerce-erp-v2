import fs from 'node:fs';
import path from 'node:path';
import {pipeline} from 'node:stream/promises';
import {spawnSync} from 'node:child_process';
import yauzl from 'yauzl';
import asar from '@electron/asar';
import {createHash} from 'node:crypto';
import {parseArgs} from 'node:util';
const {values}=parseArgs({options:{directory:{type:'string'},output:{type:'string'}}});
const directory=path.resolve(values.directory||'dist/modules');
const output=path.resolve(values.output||'dist/module-verification');
fs.mkdirSync(output,{recursive:true});
const stage=fs.mkdtempSync(path.join(output,'public-payload-'));
const reports=[];
for(const descriptor of fs.readdirSync(directory).filter(n=>n.endsWith('.descriptor.json'))){
  const spec=JSON.parse(fs.readFileSync(path.join(directory,descriptor),'utf8'));
  let entries=0,texts=0;
  const zip=await new Promise((resolve,reject)=>yauzl.open(path.join(directory,spec.archive),{lazyEntries:true},(e,z)=>e?reject(e):resolve(z)));
  await new Promise((resolve,reject)=>{
    zip.on('error',reject);zip.on('end',resolve);
    zip.on('entry',entry=>{(async()=>{
      const n=entry.fileName;entries++;
      if(/^(?:data|workspace|Partitions|Network)(\/|$)|(^|\/)(?:\.env[^/]*|secrets\.bin|Cookies)(\/|$)|\.(?:sqlite(?:-wal|-shm)?|db|pfx|pem|key)$/i.test(n))throw Error('Private file in '+spec.id+': '+n);
      if(n==='resources/app.asar'||(!n.startsWith('node_modules/')&&/\.(?:js|mjs|cjs|json|html|txt|vue|ts)$/.test(n)&&entry.uncompressedSize<20*1024**2)){
        const target=path.join(stage,spec.id,n);fs.mkdirSync(path.dirname(target),{recursive:true});
        const stream=await new Promise((ok,no)=>zip.openReadStream(entry,(e,s)=>e?no(e):ok(s)));
        await pipeline(stream,fs.createWriteStream(target));texts++;
        if(n.endsWith('.asar')){
          for(const name of asar.listPackage(target)){
            const relative=name.replaceAll('\\','/').replace(/^\//,'');
            const metadata=asar.statFile(target,path.normalize(relative));
            if(metadata.integrity){
              const actual=createHash('sha256').update(asar.extractFile(target,path.normalize(relative))).digest('hex');
              if(actual!==metadata.integrity.hash)throw Error('ASAR internal integrity mismatch: '+spec.id+'/'+relative);
            }
            if(relative.startsWith('node_modules/'))continue;
            if(/(^|\/)(?:data|workspace|Partitions|\.env[^/]*|secrets\.bin)(\/|$)|\.(?:sqlite|db|pem|key|pfx)$/i.test(relative))throw Error('Private ASAR file: '+relative);
            if(/\.(?:mjs|cjs|js|json|html|ts)$/.test(relative)){
              const dest=path.join(stage,spec.id,'asar-source',relative);fs.mkdirSync(path.dirname(dest),{recursive:true});
              fs.writeFileSync(dest,asar.extractFile(target,path.normalize(relative)));texts++;
            }
          }
          fs.unlinkSync(target);
        }
      }
      zip.readEntry();
    })().catch(error=>{zip.close();reject(error);});});
    zip.readEntry();
  });
  reports.push({id:spec.id,entries,scannedFirstPartyFiles:texts});
}
const leakReport=path.join(output,'module-secrets.json');
// Browser binaries/resources are the verified upstream Playwright distribution;
// its bundled public Chrome extension key is not a user's secret.
const scanConfig=path.join(output,'payload-gitleaks.toml');
fs.writeFileSync(scanConfig,'[extend]\nuseDefault=true\n[[allowlists]]\ndescription="Upstream Chromium public extension identity"\npaths=["reading_mode_gdocs_helper_manifest\\\\.json$"]\n');
const scan=spawnSync('gitleaks',['dir',stage,'--config',scanConfig,'--redact','--no-banner','--log-level','error','--report-format','json','--report-path',leakReport],{windowsHide:true,encoding:'utf8'});
if(scan.status!==0)throw Error('Public payload secret scan requires review; see local redacted report');
fs.writeFileSync(path.join(output,'public-payload.json'),JSON.stringify({ok:true,privateFilesAbsent:true,detectedSecrets:0,packages:reports},null,2));
console.log(JSON.stringify({ok:true,packages:reports}));
