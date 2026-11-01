import {workerData} from 'node:worker_threads';
import {pathToFileURL} from 'node:url';
// Execute the existing server's own guarded main entry so startup, shutdown,
// collectors and business schedules retain their module-specific behaviour.
process.argv[1]=workerData.entry;
await import(pathToFileURL(workerData.entry).href);
