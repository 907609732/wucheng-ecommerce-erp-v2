const MAX_STDOUT=2*1024*1024;
const invalid=()=>Object.assign(Error('云仓命令未返回有效 JSON 结果'),{code:'CLI_STDOUT_INVALID'});
const envelope=value=>value&&typeof value==='object'&&!Array.isArray(value)&&typeof value.ok==='boolean';

export function parseCliJsonOutput(output,{maxBytes=MAX_STDOUT,maxPrefixBytes=8192,maxPrefixLines=64}={}){
  const text=Buffer.isBuffer(output)?output.toString('utf8'):String(output||'');
  if(Buffer.byteLength(text,'utf8')>maxBytes)throw Object.assign(Error('云仓命令返回内容超过限制'),{code:'CLI_STDOUT_TOO_LARGE'});
  const source=text.trim();
  try{const value=JSON.parse(source);if(envelope(value))return value;}catch{}
  // A small number of startup log lines may precede the result. Parse the
  // entire remaining JSON object, never the final line of a pretty envelope.
  let offset=0;
  for(let lines=0;lines<maxPrefixLines;lines++){
    const next=source.indexOf('\n',offset);if(next<0)break;offset=next+1;
    if(Buffer.byteLength(source.slice(0,offset),'utf8')>maxPrefixBytes)break;
    const candidate=source.slice(offset).trimStart();if(!candidate.startsWith('{'))continue;
    try{const value=JSON.parse(candidate);if(envelope(value))return value;}catch{}
  }
  throw invalid();
}

// Used by the launcher and invocation-level fixtures. Buffer chunks are decoded
// once so a UTF-8 character split across pipe events is not corrupted. Stderr
// is drained but never copied into returned JSON or public error messages.
export function readCliChildResult(child,{maxBytes=MAX_STDOUT}={}){
  return new Promise((resolve,reject)=>{
    const chunks=[];let bytes=0,tooLarge=false,settled=false;
    const fail=error=>{if(!settled){settled=true;reject(error);}};
    child.stdout.on('data',part=>{
      const buffer=Buffer.isBuffer(part)?part:Buffer.from(part);bytes+=buffer.length;
      if(bytes>maxBytes){tooLarge=true;child.kill();return;}
      chunks.push(buffer);
    });
    child.stderr?.resume();
    child.once('error',error=>fail(Object.assign(Error('无法启动云仓命令'),{code:error.code||'CLI_START_FAILED'})));
    child.once('close',code=>{
      if(settled)return;
      try{
        if(tooLarge)throw Object.assign(Error('云仓命令返回内容超过限制'),{code:'CLI_STDOUT_TOO_LARGE'});
        const result=parseCliJsonOutput(Buffer.concat(chunks),{maxBytes});
        if(code===null||code!==0&&result.ok!==false)throw Object.assign(Error('云仓命令未完成'+(code===null?'':'（退出码 '+code+'）')),{code:'CLI_EXIT_FAILED'});
        settled=true;resolve(result);
      }catch(error){fail(error);}
    });
  });
}
