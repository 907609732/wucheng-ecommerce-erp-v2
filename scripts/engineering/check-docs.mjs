import fs from 'node:fs';
import path from 'node:path';
const files=['README.md',...fs.readdirSync('docs').filter(f=>f.endsWith('.md')).map(f=>'docs/'+f)],missing=[];
for(const file of files){
 const content=fs.readFileSync(file,'utf8');
 for(const match of content.matchAll(/\]\(([^)]+)\)/g)){
  const target=match[1].split('#')[0];if(!target||/^[a-z]+:/i.test(target))continue;
  if(!fs.existsSync(path.resolve(path.dirname(file),decodeURIComponent(target))))missing.push({file,target});
 }
}
console.log(JSON.stringify({ok:!missing.length,files:files.length,missing}));if(missing.length)process.exitCode=1;
