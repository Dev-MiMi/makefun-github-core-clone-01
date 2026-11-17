import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {Store,ApiError} from '../domain.mjs';

// Exercise entrypoint configuration and shutdown without binding forbidden sockets.
const source=readFileSync(new URL('../main.ts',import.meta.url),'utf8');
const functions=source.slice(0,source.indexOf('Promise.resolve()'));
function entry(env={}){
  const process=new EventEmitter();process.env=env;
  const messages=[],timers=[];
  const context={process,URL,console:{error:message=>messages.push(message)},
    setTimeout(fn,ms){const timer={fn,ms,unref(){this.unreferenced=true;}};timers.push(timer);return timer;},
    clearTimeout(timer){timer.cleared=true;}};
  const api=runInNewContext(functions+'\n({validateStartup,manageServer,reportFailure})',context);
  return {api,process,messages,timers,context};
}

test('startup rejects invalid local ports, environment URLs and empty tokens',()=>{
  for(const port of ['-1','65536','1.5','NaN','',' 3000','1e3'])assert.throws(()=>entry({FORGE_PORT:port}).api.validateStartup(),/FORGE_PORT/);
  for(const port of ['0','3000','65535','8080'])assert.doesNotThrow(()=>entry({FORGE_PORT:port}).api.validateStartup());
  for(const url of ['garbage','file:///tmp/forge','http://user:pass@localhost'])assert.throws(()=>entry({MAKEFUN_ENV_URL:url}).api.validateStartup(),/MAKEFUN_ENV_URL/);
  assert.doesNotThrow(()=>entry({MAKEFUN_ENV_URL:'http://store:8080',FORGE_PORT:'ignored'}).api.validateStartup());
  for(const token of ['', '  '])assert.throws(()=>entry({FORGE_TOKEN:token}).api.validateStartup(),/token/);
  assert.doesNotThrow(()=>entry({FORGE_TOKEN:'ignored',MAKEFUN_SHOP_TOKEN:'trial-token'}).api.validateStartup());
});

function serverMock(){
  const server=new EventEmitter();server.closeCalls=0;server.forceCalls=0;
  server.close=callback=>{server.closeCalls++;server.callback=callback;};
  server.closeAllConnections=()=>server.forceCalls++;
  return server;
}
test('signals close once, bound stalled connections and remove process listeners',()=>{
  const {api,process,timers}=entry(),server=serverMock();api.manageServer(server);
  process.emit('SIGTERM');process.emit('SIGINT');
  assert.equal(server.closeCalls,1);assert.equal(timers[0].ms,10000);assert.equal(timers[0].unreferenced,true);
  timers[0].fn();assert.equal(server.forceCalls,1);
  server.emit('close');server.callback();
  assert.equal(timers[0].cleared,true);assert.equal(process.listenerCount('SIGTERM'),0);assert.equal(process.listenerCount('SIGINT'),0);
});
test('asynchronous server errors set an unsuccessful exit status and close the server',()=>{
  const {api,process,messages,context}=entry(),server=serverMock();api.manageServer(server);
  context.server=server;
  runInNewContext("server.emit('error',new Error('listen failed'))",context);
  assert.equal(process.exitCode,1);assert.equal(server.closeCalls,1);assert.match(messages[0],/server error: Error: listen failed/);
  api.reportFailure('startup failed','module unavailable');
  assert.match(messages[1],/startup failed: module unavailable/);
});

const serverSource=readFileSync(new URL('../server.mjs',import.meta.url),'utf8')
  .replace(/^import .*;\n/gm,'').replaceAll('export function ','function ');
test('a framed sole Buffer chunk is passed to Git without a copy',async()=>{
  const input=Buffer.from('git payload');let received;
  const {createHandler}=runInNewContext(serverSource+'\n({createHandler})',{
    Buffer,URL,Store,ApiError,handleGit(store,req,res,url,bytes){received=bytes;return true;}
  });
  const request={headers:{authorization:'Bearer test','content-length':String(input.length)},
    url:'/alice/forge.git/git-upload-pack',method:'POST',async *[Symbol.asyncIterator](){yield input;}};
  await createHandler(new Store(),'test')(request,{setHeader(){}});
  assert.equal(received,input);
});

test('startup registers an ephemeral port, authenticates polls and exits only on done true',async()=>{
  const calls=[],exits=[],server=new EventEmitter();let listening;
  server.listen=(port,host,callback)=>{listening={port,host,callback};};
  server.address=()=>({port:43210});server.close=()=>server.emit('close');
  server.closeAllConnections=()=>{server.forceClosed=true;};
  let poll=0;
  const {startServer}=runInNewContext(serverSource+'\n({startServer})',{
    Buffer,URL,Store,ApiError,AbortController,AbortSignal,console:{log(){},error(){}},
    process:{env:{MAKEFUN_ENV_URL:'http://store:8080/',MAKEFUN_SHOP_TOKEN:'trial-token',FORGE_PORT:'8080'},exit:code=>exits.push(code)},
    createServer:()=>server,setTimeout:callback=>callback(),
    fetch:async(url,init)=>{calls.push({url,...init});return url.endsWith('/register')?{ok:true}:{json:async()=>({done:++poll===1?'true':true})};}
  });
  assert.equal(startServer(),server);assert.equal(listening.port,0);assert.equal(listening.host,'0.0.0.0');
  await listening.callback();
  assert.equal(calls.length,3);assert.equal(calls[0].url,'http://store:8080/register');
  assert.equal(calls[0].method,'POST');assert.equal(JSON.parse(calls[0].body).port,43210);
  assert.equal(calls[1].url,'http://store:8080/done');
  for(const call of calls)assert.equal(call.headers.authorization,'Bearer trial-token');
  assert.deepEqual(exits,[0]);assert.equal(server.forceClosed,true);assert.equal(calls[0].signal.aborted,true);
});
