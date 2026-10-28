import {EventEmitter} from 'node:events';
import {agentError} from './approval.mjs';
import {stopEngine} from './engine-common.mjs';

/** NDJSON JSON-RPC 2.0 transport used by the documented Codex App Server. */
export class StdioRpc extends EventEmitter{
  constructor(child){super();this.child=child;this.pending=new Map();this.sequence=0;this.buffer='';child.stdout.setEncoding('utf8');child.stdout.on('data',text=>this.read(text));child.on('error',e=>this.fail(e));child.on('exit',()=>this.fail(agentError('ENGINE_EXITED','执行引擎已退出',503)));}
  send(value){if(!this.child.stdin.writable)throw agentError('ENGINE_CLOSED','执行引擎连接已关闭',503);this.child.stdin.write(JSON.stringify(value)+'\n');}
  request(method,params={},timeoutMs=30000){const id=++this.sequence;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(agentError('ENGINE_TIMEOUT','执行引擎未及时响应',504));},timeoutMs);this.pending.set(id,{resolve,reject,timer});this.send({jsonrpc:'2.0',id,method,params});});}
  notify(method,params={}){this.send({jsonrpc:'2.0',method,params});}
  read(text){this.buffer+=text;if(this.buffer.length>8*1024*1024){this.fail(agentError('ENGINE_MESSAGE_LIMIT','引擎消息超过限制',502));this.child.kill();return;}let at;while((at=this.buffer.indexOf('\n'))>=0){const line=this.buffer.slice(0,at);this.buffer=this.buffer.slice(at+1);if(!line.trim())continue;let message;try{message=JSON.parse(line);}catch{this.fail(agentError('ENGINE_PROTOCOL_INVALID','引擎返回无效协议消息',502));this.child.kill();return;}if(message.method&&message.id!==undefined){this.emit('request',message);continue;}if(message.method){this.emit('notification',message);continue;}const pending=this.pending.get(message.id);if(!pending)continue;clearTimeout(pending.timer);this.pending.delete(message.id);if(message.error)pending.reject(agentError('ENGINE_RPC_ERROR',message.error.message||'引擎请求失败',502));else pending.resolve(message.result);}}
  fail(error){for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(error);}this.pending.clear();this.emit('closed',error);}
  close(){return stopEngine(this.child);}
}
