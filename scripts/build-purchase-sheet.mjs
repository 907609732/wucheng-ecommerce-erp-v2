import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
await build({ entryPoints: [path.join(root, 'desktop/renderer/purchase-sheet-entry.js')], bundle: true, outfile: path.join(root, 'desktop/renderer/vendor/purchase-sheet.js'), format: 'iife', platform: 'browser', target: 'chrome140', minify: true, legalComments: 'eof', define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'info' });
await fs.copyFile(path.join(root, 'node_modules/@univerjs/core/LICENSE'), path.join(root, 'desktop/renderer/vendor/UNIVER-LICENSE.txt'));
