import fs from 'node:fs';
import {createRequire} from 'node:module';

// Package payloads may themselves contain app.asar. Electron's patched fs
// interprets that filename as a virtual directory, including while it is being
// written. Use Electron's supported raw filesystem API for external packages.
export default process.versions.electron ? createRequire(import.meta.url)('original-fs') : fs;
