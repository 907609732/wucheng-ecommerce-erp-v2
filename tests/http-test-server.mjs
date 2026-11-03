import {once} from 'node:events';
/** OS-assigned ports can be blocked by Fetch; retry only that explicit condition. */
export async function listenForFetch(app){
 for(let attempt=0;attempt<10;attempt++){
  const server=app.listen(0,'127.0.0.1');await once(server,'listening');
  try{const response=await fetch('http://127.0.0.1:'+server.address().port+'/__test_port_probe__',{signal:AbortSignal.timeout(3000)});await response.arrayBuffer();return server;}
  catch(error){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));if(error.cause?.message!=='bad port')throw error;}
 }
 throw Error('OS did not assign a Fetch-compatible test port');
}
