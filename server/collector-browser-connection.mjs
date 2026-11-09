const endpoints={sales:'LINGTU_SALES_CDP_ENDPOINT',overview:'LINGTU_OVERVIEW_CDP_ENDPOINT'};

// MCP's SDK keeps a small default environment which omits this loader setting.
// Add only the trusted native launcher value; HOME/PATH remain SDK-managed.
export function collectorChildEnvironment({platform=process.platform,env=process.env}={}) {
  return platform==='linux'&&env.LD_LIBRARY_PATH?{LD_LIBRARY_PATH:env.LD_LIBRARY_PATH}:{};
}

export function collectorConnection(id,{platform=process.platform,env=process.env}={}) {
  if(!Object.hasOwn(endpoints,id))throw Error('采集模块无效');
  if(platform==='win32')return {args:['--extension'],usesExtension:true};
  if(platform!=='linux')throw Error('当前系统尚不支持菜鸟浏览器采集');
  const endpoint=env[endpoints[id]];
  if(!endpoint)throw Error(`${id} 的 NAS 浏览器尚未配置`);
  const match=/^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})\/?$/.exec(endpoint);
  if(!match || Number(match[1])>65535)throw Error('NAS 浏览器 CDP 地址必须指向本机回环端口');
  return {args:['--cdp-endpoint',`http://127.0.0.1:${Number(match[1])}`],usesExtension:false};
}
