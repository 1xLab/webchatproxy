import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProviderRegistry } from '../src/core/provider-registry.mjs';
import { JobManager } from '../src/core/job-manager.mjs';
import { createHttpServer } from '../src/http/server.mjs';

class FakeAdapter {
  constructor(id, concurrency=2){this.id=id;this.concurrency=concurrency;this.capabilities={chat:true,conversations:true};this.lastRequest=null;}
  describe(){return {id:this.id,concurrency:this.concurrency,capabilities:this.capabilities};}
  async models(){return {object:'list',data:[{id:`${this.id}-model`,object:'model'}]};}
  async chat(request){this.lastRequest=request;await new Promise(r=>setTimeout(r,5));return {content:`${this.id}:${request.messages.at(-1).content}`,conversation_id:request.conversation_id||`${this.id}-conv`,model:request.model||'fake',finish_reason:'stop',usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}};}
}

test('universal jobs preserve provider, model, conversation and extra parameters',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'webchatproxy-')); try{
  const registry=new ProviderRegistry();const adapter=new FakeAdapter('antigravity',2);registry.register(new FakeAdapter('chatgpt',1));registry.register(adapter);
  const jobs=await new JobManager({registry,runtimeDir:dir}).init();
  const {job}=await jobs.create({provider:'antigravity',model:'gemini-x',metadata:{task:'coding'},temperature:0.2,messages:[{role:'user',content:'hello'}]},{requestId:'req-1'});
  const done=await jobs.waitFor(job.id,1000);assert.equal(done.status,'completed');assert.equal(done.conversation_id,'antigravity-conv');assert.equal(done.model,'gemini-x');assert.equal(done.result.content,'antigravity:hello');assert.deepEqual(adapter.lastRequest.metadata,{task:'coding'});assert.equal(adapter.lastRequest.temperature,0.2);
  const reused=await jobs.create({provider:'antigravity',model:'gemini-x',metadata:{task:'coding'},temperature:0.2,messages:[{role:'user',content:'hello'}]},{requestId:'req-1'});assert.equal(reused.reused,true);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('provider shortcut injects provider while preserving model and extras',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'webchatproxy-facade-')); let server; try{
  const registry=new ProviderRegistry();const adapter=new FakeAdapter('deepseek');registry.register(adapter);
  const jobs=await new JobManager({registry,runtimeDir:dir}).init();
  server=createHttpServer({registry,jobs,fixedProvider:'deepseek'});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const {port}=server.address();
  const response=await fetch(`http://127.0.0.1:${port}/v1/chat/completions`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'deepseek-chat',temperature:0.4,metadata:{source:'shortcut'},messages:[{role:'user',content:'ping'}]})});
  assert.equal(response.status,200);const body=await response.json();assert.equal(body.model,'deepseek-chat');assert.equal(body.gateway.provider,'deepseek');assert.equal(adapter.lastRequest.provider,'deepseek');assert.equal(adapter.lastRequest.model,'deepseek-chat');assert.equal(adapter.lastRequest.temperature,0.4);assert.deepEqual(adapter.lastRequest.metadata,{source:'shortcut'});
 }finally{if(server)await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});}
});

test('provider shortcut rejects contradictory provider',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'webchatproxy-facade-')); let server; try{
  const registry=new ProviderRegistry();registry.register(new FakeAdapter('kimi'));const jobs=await new JobManager({registry,runtimeDir:dir}).init();
  server=createHttpServer({registry,jobs,fixedProvider:'kimi'});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const {port}=server.address();
  const response=await fetch(`http://127.0.0.1:${port}/v1/chat/completions`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({provider:'chatgpt',model:'x',messages:[{role:'user',content:'ping'}]})});
  assert.equal(response.status,400);const body=await response.json();assert.equal(body.error.code,'provider_port_mismatch');
 }finally{if(server)await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});}
});

test('provider registry refuses implicit fallback',()=>{const registry=new ProviderRegistry();registry.register(new FakeAdapter('kimi'));assert.throws(()=>registry.get('missing'),/unknown provider/);});
