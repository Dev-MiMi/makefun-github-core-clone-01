import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {deflateSync} from 'node:zlib';
import {Store,putObject,commitFiles,filesAt,mergeBase,mergeText} from '../domain.mjs';
import {readPack,writePack} from '../git.mjs';
import {createHandler} from '../server.mjs';

function fixture(){const store=new Store();store.viewer='alice';store.ownerBound=true;return {store,repo:store.createRepo({name:'forge'})};}
function commit(repo,text,parents=[],mode='100644'){
  const oid=putObject(repo,'blob',text);
  return commitFiles(repo,new Map([['src/file',{oid,mode}]]),parents,text);
}
function pack(entries){const header=Buffer.alloc(12);header.write('PACK');header.writeUInt32BE(2,4);header.writeUInt32BE(entries.length,8);const bytes=Buffer.concat([header,...entries]);return Buffer.concat([bytes,createHash('sha1').update(bytes).digest()]);}
function objectHeader(type,size){const bytes=[(type<<4)|(size&15)];size=Math.floor(size/16);if(size)bytes[0]|=128;while(size){const byte=size%128;size=Math.floor(size/128);bytes.push(byte|(size?128:0));}return Buffer.from(bytes);}

test('PACK objects, thin delta bases, and trailers remain verifiable',()=>{
  const {repo}=fixture(),base=putObject(repo,'blob','hello');
  const ordinary=writePack([{type:'blob',data:Buffer.from('hello')},{type:'blob',data:Buffer.alloc(0)}]);
  assert.equal(readPack(ordinary,new Map()).get(base).data.toString(),'hello');
  const delta=Buffer.from([5,6,0x90,5,1,33]); // Copy five base bytes then insert '!'.
  const thin=pack([Buffer.concat([objectHeader(7,delta.length),Buffer.from(base,'hex'),deflateSync(delta)])]);
  assert.equal([...readPack(thin,repo.objects).values()][0].data.toString(),'hello!');
  assert.throws(()=>readPack(thin,new Map()),/Missing delta base/);
  const damaged=Buffer.from(ordinary);damaged[damaged.length-1]^=1;
  assert.throws(()=>readPack(damaged,new Map()),/checksum/);
});

test('merge bases exclude older shared ancestors despite shortcut parents',()=>{
  const {repo}=fixture(),a=commit(repo,'a'),b=commit(repo,'b',[a]);
  let c=b;for(let i=0;i<8;i++)c=commit(repo,'c'+i,[c]);
  const left=commit(repo,'left',[c,a]),right=commit(repo,'right',[b]);
  assert.equal(mergeBase(repo,left,right),b);
});

test('three-way squash merges independent lines and file modes',()=>{
  const {store,repo}=fixture(),base=commit(repo,'a\nb\nc\n');
  repo.refs.set('refs/heads/main',commit(repo,'A\nb\nc\n',[base]));
  repo.refs.set('refs/heads/feature',commit(repo,'a\nb\nC\n',[base],'100755'));
  const pull=store.createPull(repo,{title:'merge',head:'feature',base:'main'});
  const before=repo.objects.size;store.mergedFiles(repo,pull,false);assert.equal(repo.objects.size,before);
  store.mergePull(repo,pull.number);
  const file=filesAt(repo).get('src/file');assert.equal(file.mode,'100755');
  assert.equal(repo.objects.get(file.oid).data.toString(),'A\nb\nC\n');
  assert.throws(()=>mergeText(Buffer.from('a\n'),Buffer.from('b\n'),Buffer.from('c\n')),/conflict/);
});

function transport(handler){return async(path,method='GET',body,auth='Bearer test')=>{
  const bytes=Buffer.from(typeof body==='string'?body:body===undefined?'':JSON.stringify(body));
  const req={url:path,method,headers:{host:'forge.test',...(auth?{authorization:auth}:{})},async *[Symbol.asyncIterator](){if(bytes.length)yield bytes;}};
  let status=200,text='',headers={};
  const res={statusCode:200,headersSent:false,setHeader(k,v){headers[k]=v;},writeHead(s,h){status=s;headers={...headers,...h};this.headersSent=true;},end(value){text=String(value??'');}};
  await handler(req,res);return {status:res.statusCode===200?status:res.statusCode,body:text?JSON.parse(text):null,headers};
};}
test('HTTP handler authentication, errors, and REST/GraphQL/MCP identity agree',async()=>{
  const {store,repo}=fixture(),call=transport(createHandler(store,'test'));
  assert.equal((await call('/healthz','GET',undefined,null)).status,200);
  assert.equal((await call('/api/v3/user','GET',undefined,null)).status,401);
  assert.equal((await call('/api/v3/user','GET',undefined,'Basic '+Buffer.from('test').toString('base64'))).status,401);
  assert.equal((await call('/api/v3/user','GET',undefined,'Basic '+Buffer.from('alice:test').toString('base64'))).status,200);
  assert.equal((await call('/api/v3/repos/bob/forge')).status,404);
  assert.equal((await call('/api/v3/unknown')).status,404);
  assert.equal((await call('/api/v3/user/repos','POST','{')).status,400);
  assert.equal((await call('/mcp','POST','{')).body.error.code,-32700);
  const created=await call('/mcp','POST',{jsonrpc:'2.0',id:7,method:'tools/call',params:{name:'create_issue',arguments:{owner:'alice',repo:'forge',title:'shared'}}});
  assert.equal(created.body.id,7);
  const issue=JSON.parse(created.body.result.content[0].text),path=`/api/v3/repos/alice/forge/issues/${issue.number}`;
  const first=(await call(path)).body;assert.equal(first.id,issue.id);
  const query=await call('/api/graphql','POST',{query:'query($id:ID!){node(id:$id){... on Issue {id title}}}',variables:{id:first.node_id}});
  assert.equal(query.body.data.node.id,first.node_id);
  await call(path,'PATCH',{title:'updated'});assert.equal((await call(path)).body.title,'updated');
  repo.refs.set('refs/heads/main',commit(repo,'base'));repo.refs.set('refs/heads/feature',commit(repo,'next',[repo.refs.get('refs/heads/main')]));
  const pull=store.createPull(repo,{title:'pull',head:'feature',base:'main'});assert.equal(pull.number,issue.number+1);
});

test('annotated tags expose the same contents and tree as their commit',async()=>{
  const {store,repo}=fixture(),sha=commit(repo,'tagged');
  const tag=putObject(repo,'tag',`object ${sha}\ntype commit\ntag v1\ntagger Forge <forge@example.invalid> 1700000000 +0000\n\nv1\n`);
  repo.refs.set('refs/tags/v1',tag);const call=transport(createHandler(store,'test'));
  assert.equal(Buffer.from((await call('/api/v3/repos/alice/forge/contents/src/file?ref=v1')).body.content,'base64').toString(),'tagged');
  assert.equal((await call('/api/v3/repos/alice/forge/contents/src?ref=v1')).body[0].name,'file');
});
