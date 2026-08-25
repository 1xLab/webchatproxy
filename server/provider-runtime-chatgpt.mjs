import http from 'node:http';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Web2ApiEngine } from './providers/chatgpt/web2api-engine.mjs';

const baseDir=dirname(fileURLToPath(import.meta.url));
const host=process.env.CHATGPT_RUNTIME_HOST||'127.0.0.1';
const port=Number(process.env.CHATGPT_RUNTIME_PORT||3310);
const engine=new Web2ApiEngine({baseDir,runtimeDir:process.env.WEBCHAT_RUNTIME_DIR||`${baseDir}/runtime`,profileDir:process.env.WEBCHAT_PROFILE_DIR||`${baseDir}/browser-profile`,headless:process.env.WEBCHAT_HEADLESS==='1',env:{...process.env,WEBCHAT_ENGINE_PORT:process.env.WEBCHAT_ENGINE_PORT||'3311'}});
function send(res,status,payload){const body=JSON.stringify(payload);res.writeHead(status,{'content-type':'application/json; charset=utf-8','content-length':Buffer.byteLength(body),'cache-control':'no-store'});res.end(body);}
async function readJson(req){let body='';for await(const c of req)body+=c;return body.trim()?JSON.parse(body):{};}
function errPayload(error){return {error:{message:error.message||String(error),type:'chatgpt_runtime_error',param:null,code:error.code||null}};}
const server=http.createServer(async(req,res)=>{try{
 const url=new URL(req.url||'/',`http://${req.headers.host||host}`);
 if(req.method==='GET'&&url.pathname==='/health'){try{const h=await engine.health();return send(res,200,{service:'chatgpt-runtime',ok:h.driver_connected===true,engine:h});}catch(e){return send(res,503,{service:'chatgpt-runtime',ok:false,error:e.message,code:e.code||null});}}
  if(req.method==='GET'&&url.pathname==='/v1/models'){const models=await engine.listModels();return send(res,200,{object:'list',data:models.map(m=>({id:m.id??m.slug,object:'model',created:0,owned_by:'chatgpt-web',title:m.title??null})).filter(m=>typeof m.id==='string'&&m.id.length>0)});}
  if(req.method==='GET'&&url.pathname==='/v1/projects'){return send(res,200,{projects:await engine.listProjects()});}
  if(req.method==='POST'&&url.pathname==='/v1/projects'){return send(res,201,await engine.createProject(await readJson(req)));}
  const projectInstructions=url.pathname.match(/^\/v1\/projects\/([^/]+)\/instructions$/);
  if(projectInstructions&&req.method==='PATCH')return send(res,200,await engine.updateProjectInstructions(decodeURIComponent(projectInstructions[1]),String((await readJson(req)).instructions||'')));
  const projectFiles=url.pathname.match(/^\/v1\/projects\/([^/]+)\/files$/);
  if(projectFiles&&req.method==='GET')return send(res,200,await engine.listProjectFiles(decodeURIComponent(projectFiles[1])));
  const projectDelete=url.pathname.match(/^\/v1\/projects\/([^/]+)$/);
  if(projectDelete&&req.method==='DELETE')return send(res,200,await engine.deleteProject(decodeURIComponent(projectDelete[1])));
  const projectConversations=url.pathname.match(/^\/v1\/projects\/([^/]+)\/conversations$/);
  if(projectConversations&&req.method==='GET')return send(res,200,await engine.listConversations({projectId:decodeURIComponent(projectConversations[1]),all:url.searchParams.get('all')==='1',offset:Number(url.searchParams.get('offset')||0),limit:Number(url.searchParams.get('limit')||50)}));
  if(req.method==='GET'&&url.pathname==='/v1/conversations'){const result=await engine.listConversations({projectId:url.searchParams.get('project_id')||null,all:url.searchParams.get('all')==='1',offset:Number(url.searchParams.get('offset')||0),limit:Number(url.searchParams.get('limit')||50)});return send(res,200,result);}
  const cm=url.pathname.match(/^\/v1\/conversations\/([^/]+)$/);if(cm&&req.method==='GET')return send(res,200,await engine.getConversation(decodeURIComponent(cm[1])));
  const messages=url.pathname.match(/^\/v1\/conversations\/([^/]+)\/messages$/);if(messages&&req.method==='GET')return send(res,200,await engine.getConversation(decodeURIComponent(messages[1]),{offset:Number(url.searchParams.get('offset')||0),limit:Number(url.searchParams.get('limit')||500)}));
  const archive=url.pathname.match(/^\/v1\/conversations\/([^/]+)\/archive$/);if(archive&&req.method==='POST')return send(res,200,await engine.archiveConversation(decodeURIComponent(archive[1]),(await readJson(req)).archive!==false));
  if(cm&&req.method==='DELETE')return send(res,200,await engine.deleteConversation(decodeURIComponent(cm[1])));
 if(req.method==='POST'&&url.pathname==='/v1/chat/completions'){
   const body=await readJson(req);if(!Array.isArray(body.messages)||!body.messages.length)return send(res,400,{error:{message:'messages must be a non-empty array',type:'invalid_request_error'}});
   const content=await engine.ask(body.messages,{timeout:Number(body.timeout)||210000,requestId:body.request_id||null,conversationId:body.conversation_id||null,projectId:body.project_id||null,model:body.model||'auto'});
   const conversationId=engine.conversationId();
   return send(res,200,{id:`chatcmpl-chatgpt-${Date.now()}`,object:'chat.completion',created:Math.floor(Date.now()/1000),model:body.model||'auto',conversation_id:conversationId,choices:[{index:0,message:{role:'assistant',content},finish_reason:'stop'}],usage:{prompt_tokens:0,completion_tokens:0,total_tokens:0}});
 }
 return send(res,404,{error:{message:'not found',type:'invalid_request_error',code:'not_found'}});
}catch(error){return send(res,error.status||502,errPayload(error));}});
 async function start(){
  await engine.start();
  server.listen(port,host,()=>console.log(`ChatGPT internal runtime listening on http://${host}:${port}`));
 }
 start().catch((error)=>{console.error(`ChatGPT engine startup failed: ${error.message}`);process.exitCode=1;});
let stopping=false;async function stop(){if(stopping)return;stopping=true;await new Promise(r=>server.close(r));await engine.close();}
process.on('SIGTERM',()=>stop().finally(()=>process.exit(0)));process.on('SIGINT',()=>stop().finally(()=>process.exit(0)));
