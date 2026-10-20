import fs from 'node:fs';
import path from 'node:path';
import {pipeline} from 'node:stream/promises';
import {digest, extractZip} from '../desktop/modules/package-format.mjs';
const version = '24.18.0', name = `node-v${version}-win-x64.zip`;
const root = path.resolve('dist/module-runtime-source');
fs.mkdirSync(root, {recursive: true});
const base = `https://nodejs.org/dist/v${version}/`;
const sums = await fetch(base + 'SHASUMS256.txt', {signal: AbortSignal.timeout(30000)});
if (!sums.ok) throw Error('Cannot read official Node checksums');
const expected = (await sums.text()).split('\n').find(line => line.endsWith('  ' + name))?.split(' ')[0];
if (!/^[a-f0-9]{64}$/.test(expected || '')) throw Error('Missing official Node checksum');
const archive = path.join(root, name);
if (!fs.existsSync(archive) || await digest(archive) !== expected) {
  const response = await fetch(base + name, {signal: AbortSignal.timeout(120000)});
  if (!response.ok) throw Error('Cannot download official Node runtime');
  await pipeline(response.body, fs.createWriteStream(archive));
}
if (await digest(archive) !== expected) throw Error('Node runtime checksum mismatch');
const destination = path.join(root, 'verified');
if (!fs.existsSync(destination)) await extractZip(archive, destination, {maxBytes: 300 * 1024 ** 2});
console.log(path.join(destination, `node-v${version}-win-x64`));
