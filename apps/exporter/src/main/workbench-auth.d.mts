export interface WorkbenchActor {v:1;id:string;login:string;role:'admin'|'editor'|'viewer';modules:string[];canRunTasks:boolean;sessionId:string;channel:'ui'|'cli'|'mcp';requestId:string;issuedAt:number;expiresAt:number;module:string;method:string;path:string}
export function provisionWorkbenchKey(dataDir:string):string;
export function signWorkbenchActor(actor:WorkbenchActor,key:string):Record<string,string>;
export function verifyWorkbenchActor(headers:Record<string,unknown>,key:string,request:{module:string;method:string;path:string;now?:number}):WorkbenchActor;
