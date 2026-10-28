import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
const defaults={brand:'BY五成',website:'',githubRepo:'',statsEndpoint:''};
let config=defaults;
try{config={...defaults,...JSON.parse(fs.readFileSync(path.join(root,'config.json'),'utf8'))};}catch{config=defaults;}

export const appVersion=pkg.version||'1.3.2';
export const appBrand=config.brand||'BY五成';
export const appWebsite=config.website||'';
export const appGithubRepo=config.githubRepo||'';
export const appStatsEndpoint=config.statsEndpoint||'';
