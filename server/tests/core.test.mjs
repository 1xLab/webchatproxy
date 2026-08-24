import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProviderRegistry } from '../src/core/provider-registry.mjs';
import { JobManager } from '../src/core/job-manager.mjs';

class FakeAdapter {
  constructor(id, concurrency=2){this.id=id;this.concurrency=concurrency;this.capabilities={chat:true,conversations:true};}
  describe(){return {id:this.id,concurrency:this.concurrency,capabilities:this.capabilities};}
  async chat(request){await new Promise(r=>setTimeout(r,5));return {content:`${this.id}:${request.messages.at(-1).content}`,conversation_id:request.conversation_id||`${this.id}-conv`,model:request.model||'fake',finish_reason:'stop',usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}};}
}

test('universal jobs preserve provider and conversation id',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'webchatproxy-')); try{
  const registry=new ProviderRegistry();registry.register(new FakeAdapter('chatgpt',1));registry.register(new FakeAdapter('antigravity',2));
  const jobs=await new JobManager({registry,runtimeDir:dir}).init();
  const {job}=await jobs.create({provider:'antigravity',model:'m',messages:[{role:'user',content:'hello'}]},{requestId:'req-1'});
  const done=await jobs.waitFor(job.id,1000);assert.equal(done.status,'completed');assert.equal(done.conversation_id,'antigravity-conv');assert.equal(done.result.content,'antigravity:hello');
  const reused=await jobs.create({provider:'antigravity',model:'m',messages:[{role:'user',content:'hello'}]},{requestId:'req-1'});assert.equal(reused.reused,true);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('provider registry refuses implicit fallback',()=>{const registry=new ProviderRegistry();registry.register(new FakeAdapter('kimi'));assert.throws(()=>registry.get('missing'),/unknown provider/);});
