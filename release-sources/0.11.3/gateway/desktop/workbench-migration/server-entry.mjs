import path from 'node:path';
import {ServiceManager} from '../shared/service-manager.mjs';
import {runWorkbenchServer} from '../workbench/server.mjs';
import {migrationRoutes} from './routes.mjs';
const args={};for(let i=2;i<process.argv.length;i+=2){if(!process.argv[i].startsWith('--')||!process.argv[i+1])throw Error('启动参数无效');args[process.argv[i].slice(2)]=process.argv[i+1];}
const services=new ServiceManager();
const gateway=await runWorkbenchServer({storeDir:path.resolve(args['store-dir']),publicOrigin:args.origin,registryFile:services.registryFile,port:Number(args.port||17330),registerRoutes:migrationRoutes(services)});
process.stdout.write(JSON.stringify({ok:true,serverId:gateway.serverId,dataSetId:gateway.dataSetId})+'\n');
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>gateway.stop().then(()=>process.exit(0)));
