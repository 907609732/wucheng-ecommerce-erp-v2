import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createTailnetBroker} from './tailnet-broker.mjs';

export async function readTailnetBrokerInit(input=process.stdin){
 const chunks=[];let bytes=0;
 for await(const chunk of input){bytes+=chunk.length;if(bytes>16384)throw Error('TAILNET_BROKER_INIT_TOO_LARGE');chunks.push(chunk);}
 return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
export async function runTailnetBrokerEntry(options={}){
 const init=await readTailnetBrokerInit(),broker=await createTailnetBroker(init,options);
 const stop=()=>{void broker.close().then(()=>{process.exitCode=0;},()=>{process.exitCode=1;});};
 process.once('SIGTERM',stop);process.once('SIGINT',stop);return broker;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 runTailnetBrokerEntry().catch(()=>{process.exitCode=1;});
}
