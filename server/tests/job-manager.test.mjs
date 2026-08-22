import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { JobManager } from "../lib/job-manager.mjs";

class JournalStub { constructor(){this.events=[];} record(event,data={},level="info"){this.events.push({event,level,...data});} }
class FakeBackend {
  constructor(){this.progress=new Map();this.block=false;this.release=null;this.currentRequestId=null;this.failOnce=false;this.restartCalls=0;this.conversationIdValue="test-conversation-123";}
  progressOf(id){return this.progress.get(id)||null;}
  conversationId(){return this.conversationIdValue;}
  async restart(){this.restartCalls++;return {status:"healthy",driver_connected:true};}
  async ask(messages,options){
    this.currentRequestId=options.requestId;
    if(this.failOnce){this.failOnce=false;const error=new Error("engine unavailable");error.code="ENGINE_UNAVAILABLE";throw error;}
    this.progress.set(options.requestId,{status:"running",content:"partial",updatedAt:Date.now()});
    if(this.block)await new Promise((resolve)=>{this.release=resolve;});
    const last=messages.at(-1)?.content||"";this.progress.set(options.requestId,{status:"completed",content:`reply:${last}`,updatedAt:Date.now()});return `reply:${last}`;
  }
}
async function fixture(){const runtimeDir=await mkdtemp(join(tmpdir(),"webchat-job-test-"));const backend=new FakeBackend();const journal=new JournalStub();const manager=new JobManager({backend,journal,runtimeDir});await manager.init();return{runtimeDir,backend,journal,manager};}
async function waitUntil(predicate,timeout=1000){const deadline=Date.now()+timeout;while(Date.now()<deadline){if(predicate())return;await new Promise(r=>setTimeout(r,10));}throw new Error("condition timeout");}

test("job completes and cleans live state",async()=>{const f=await fixture();try{const created=await f.manager.create({messages:[{role:"user",content:"ping"}],request_id:"test-job-1"});const finished=await f.manager.waitFor(created.job.id,2000);assert.equal(finished.status,"completed");assert.equal(finished.result.content,"reply:ping");assert.equal(finished.conversation_id,"test-conversation-123");assert.equal(f.backend.currentRequestId,null);assert.equal(f.backend.progress.has("test-job-1"),false);}finally{await rm(f.runtimeDir,{recursive:true,force:true});}});

test("engine conversation id is persisted",async()=>{const f=await fixture();try{f.backend.conversationIdValue="generated-conversation-456";const created=await f.manager.create({messages:[{role:"user",content:"new chat"}],request_id:"conversation-job"});const finished=await f.manager.waitFor(created.job.id,2000);assert.equal(finished.status,"completed");assert.equal(finished.conversation_id,"generated-conversation-456");const persisted=JSON.parse(await readFile(join(f.runtimeDir,"jobs","conversation-job.json"),"utf8"));assert.equal(persisted.conversation_id,"generated-conversation-456");assert.ok(f.journal.events.some(e=>e.event==="job_finished"&&e.conversationId==="generated-conversation-456"));}finally{await rm(f.runtimeDir,{recursive:true,force:true});}});

test("same request id and same payload is idempotent",async()=>{const f=await fixture();try{const payload={messages:[{role:"user",content:"one"}],request_id:"same-id"};const first=await f.manager.create(payload);const second=await f.manager.create(payload);assert.equal(first.reused,false);assert.equal(second.reused,true);await f.manager.waitFor("same-id",2000);}finally{await rm(f.runtimeDir,{recursive:true,force:true});}});

test("different payload with same request id is rejected",async()=>{const f=await fixture();try{await f.manager.create({messages:[{role:"user",content:"one"}],request_id:"conflict-id"});await assert.rejects(()=>f.manager.create({messages:[{role:"user",content:"two"}],request_id:"conflict-id"}),(e)=>e?.code==="REQUEST_ID_CONFLICT");await f.manager.waitFor("conflict-id",2000);}finally{await rm(f.runtimeDir,{recursive:true,force:true});}});

test("queued job can be cancelled",async()=>{const f=await fixture();try{f.backend.block=true;await f.manager.create({messages:[{role:"user",content:"first"}],request_id:"first"});await waitUntil(()=>f.manager.stats().running==="first");await f.manager.create({messages:[{role:"user",content:"second"}],request_id:"second"});assert.equal((await f.manager.cancel("second")).status,"cancelled");f.backend.release();assert.equal((await f.manager.waitFor("first",2000)).status,"completed");}finally{await rm(f.runtimeDir,{recursive:true,force:true});}});

test("engine unavailability is recovered once automatically",async()=>{const f=await fixture();try{f.backend.failOnce=true;await f.manager.create({messages:[{role:"user",content:"recover"}],request_id:"recover-job"});const finished=await f.manager.waitFor("recover-job",2000);assert.equal(finished.status,"completed");assert.equal(finished.result.content,"reply:recover");assert.equal(f.backend.restartCalls,1);assert.ok(f.journal.events.some(e=>e.event==="engine_auto_recovery"));}finally{await rm(f.runtimeDir,{recursive:true,force:true});}});

test("old terminal job files are removed on init",async()=>{const runtimeDir=await mkdtemp(join(tmpdir(),"webchat-job-cleanup-"));try{const jobsDir=join(runtimeDir,"jobs");await mkdir(jobsDir,{recursive:true});const old=new Date(Date.now()-20*86400000).toISOString();await writeFile(join(jobsDir,"old.json"),JSON.stringify({id:"old",status:"completed",created_at:old,updated_at:old,finished_at:old}));const backend=new FakeBackend();const journal=new JournalStub();const previous=process.env.WEBCHAT_JOB_RETENTION_DAYS;process.env.WEBCHAT_JOB_RETENTION_DAYS="14";const manager=new JobManager({backend,journal,runtimeDir});await manager.init();if(previous===undefined)delete process.env.WEBCHAT_JOB_RETENTION_DAYS;else process.env.WEBCHAT_JOB_RETENTION_DAYS=previous;assert.equal(manager.get("old"),null);await assert.rejects(()=>readFile(join(jobsDir,"old.json"),"utf8"));}finally{await rm(runtimeDir,{recursive:true,force:true});}});
