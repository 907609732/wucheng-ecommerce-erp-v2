export class ServiceManager {
  constructor(options?:{registryFile?:string});
  registryFile:string;
  config(id:string):any;
  ensure(id:string):Promise<any>;
  capabilities(id:string):Promise<any>;
  request(id:string,route:string,options?:{method?:string;body?:unknown}):Promise<any>;
}
