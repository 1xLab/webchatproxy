import crypto from 'node:crypto';
import http from 'node:http';

function send(res,status,payload){const body=JSON.stringify(payload);res.writeHead(status,{'content-type':'application/json; charset=utf-8','content-length':Buffer.byteLength(body),'cache-control':'no-store'});res.end(body);}
async function readJson(req){let body='';for await(const c of req){body+=c;if(body.length>2*1024*1024)throw new Error('request_body_too_large');}return body.trim()?JSON.parse(body):{};}
function authorized(req,token){if(!token)return true;const supplied=String(req.headers.authorization||'').replace(/^Bearer\s+/i,'');const a=Buffer.from(supplied),b=Buffer.from(token);return a.length===b.length&&a.length>0&&crypto.timingSafeEqual(a,b);}
function openAi(job){return {id:`chatcmpl-${job.id}`,object:'chat.completion',created:Math.floor(new Date(job.created_at).getTime()/1000),model:job.model||'unknown',choices:[{index:0,message:{role:'assistant',content:job.result?.content||''},finish_reason:job.result?.finish_reason||null}],usage:job.usage||{prompt_tokens:0,completion_tokens:0,total_tokens:0},gateway:{job_id:job.id,provider:job.provider,conversation_id:job.conversation_id,status:job.status,usage_measurement:job.usage_measurement||null}};}
function openAiError(message,type='gateway_error',code=null){return {error:{message,type,param:null,code}};}
function streamCompletion(res,job){
  const response=openAi(job); const choice=response.choices[0];
  res.writeHead(200,{'content-type':'text/event-stream; charset=utf-8','cache-control':'no-cache','connection':'keep-alive','x-accel-buffering':'no'});
  const emit=(delta,finish_reason=null,usage=null)=>res.write(`data: ${JSON.stringify({id:response.id,object:'chat.completion.chunk',created:response.created,model:response.model,choices:[{index:0,delta,finish_reason}],...(usage?{usage}:{}),gateway:response.gateway})}\n\n`);
  emit({role:'assistant'}); if(choice.message.content)emit({content:choice.message.content}); emit({},choice.finish_reason||'stop',response.usage); res.write('data: [DONE]\n\n'); res.end();
}
function usageFilters(url){return {provider:url.searchParams.get('provider')||null,model:url.searchParams.get('model')||null,conversationId:url.searchParams.get('conversation_id')||null,jobId:url.searchParams.get('job_id')||null,from:url.searchParams.get('from')||null,to:url.searchParams.get('to')||null,limit:url.searchParams.get('limit')||1000};}

export function createHttpServer({registry,jobs,usage=null,token='',fixedProvider=null,codex=null}){
  const facadeProvider=fixedProvider?String(fixedProvider).trim().toLowerCase():null;
  if(facadeProvider)registry.get(facadeProvider);
  return http.createServer(async(req,res)=>{
    try{
      const url=new URL(req.url||'/',`http://${req.headers.host||'localhost'}`);
      if(req.method==='GET'&&url.pathname==='/health')return send(res,200,{service:'webchatproxy',ok:true,mode:facadeProvider?'provider-facade':'universal',provider:facadeProvider,providers:registry.ids(),jobs:jobs.stats()});
      if(!authorized(req,token))return send(res,401,openAiError('unauthorized','authentication_error','invalid_api_key'));
      if(codex&&req.method==='GET'&&url.pathname==='/v1/auth/codex/start')return send(res,200,{object:'oauth.authorization',url:await codex.auth.startLogin()});
      if(codex&&req.method==='GET'&&url.pathname==='/v1/auth/codex/status')return send(res,200,{object:'oauth.status',...await codex.auth.status()});
      if(codex&&req.method==='POST'&&url.pathname==='/v1/auth/codex/logout'){codex.auth.close();return send(res,200,{ok:true});}
      if(req.method==='GET'&&url.pathname==='/v1/providers')return send(res,200,{object:'list',data:facadeProvider?[registry.get(facadeProvider).describe()]:registry.describe()});
      if(req.method==='GET'&&url.pathname==='/v1/models'){
        const provider=facadeProvider||url.searchParams.get('provider'); if(!provider)return send(res,400,openAiError('provider is required','invalid_request_error','provider_required'));
        return send(res,200,await registry.get(provider).models());
      }
      if(req.method==='GET'&&url.pathname==='/v1/usage/summary'){
        if(!usage)return send(res,503,openAiError('usage store unavailable','gateway_error','usage_unavailable'));
        const filters=usageFilters(url); if(facadeProvider)filters.provider=facadeProvider;
        return send(res,200,{object:'usage.summary',...usage.summary(filters)});
      }
      if(req.method==='GET'&&url.pathname==='/v1/usage/events'){
        if(!usage)return send(res,503,openAiError('usage store unavailable','gateway_error','usage_unavailable'));
        const filters=usageFilters(url); if(facadeProvider)filters.provider=facadeProvider;
        return send(res,200,{object:'list',data:usage.query(filters)});
      }
      const usageJob=url.pathname.match(/^\/v1\/usage\/jobs\/([^/]+)$/);
      if(req.method==='GET'&&usageJob){if(!usage)return send(res,503,openAiError('usage store unavailable','gateway_error','usage_unavailable'));const id=decodeURIComponent(usageJob[1]);const data=usage.query({jobId:id,limit:1});return data.length?send(res,200,{object:'usage.job',data:data[0]}):send(res,404,openAiError('usage job not found','invalid_request_error','usage_not_found'));}
      const usageConversation=url.pathname.match(/^\/v1\/usage\/conversations\/([^/]+)$/);
      if(req.method==='GET'&&usageConversation){if(!usage)return send(res,503,openAiError('usage store unavailable','gateway_error','usage_unavailable'));const id=decodeURIComponent(usageConversation[1]);const filters={...usageFilters(url),conversationId:id};if(facadeProvider)filters.provider=facadeProvider;return send(res,200,{object:'usage.conversation',conversation_id:id,...usage.summary(filters)});}
      if(req.method==='GET'&&url.pathname==='/v1/jobs')return send(res,200,{jobs:jobs.list({limit:url.searchParams.get('limit')||100}),stats:jobs.stats()});
      const match=url.pathname.match(/^\/v1\/jobs\/([^/]+)$/);
      if(match){const id=decodeURIComponent(match[1]);if(req.method==='GET'){const job=jobs.get(id);return job?send(res,200,{job}):send(res,404,{error:'job_not_found'});}if(req.method==='DELETE'){const job=await jobs.cancel(id);return job?send(res,200,{job}):send(res,404,{error:'job_not_found'});}}
      if(req.method==='POST'&&(url.pathname==='/v1/jobs'||url.pathname==='/v1/chat/completions')){
        const incoming=await readJson(req);
        if(facadeProvider&&incoming.provider&&String(incoming.provider).trim().toLowerCase()!==facadeProvider)return send(res,400,openAiError(`provider is fixed by this port: ${facadeProvider}`,'invalid_request_error','provider_port_mismatch'));
        const payload=facadeProvider?{...incoming,provider:facadeProvider}:incoming;
        const requestId=req.headers['idempotency-key']||payload.request_id||null; const created=await jobs.create(payload,{requestId});
        if(url.pathname==='/v1/jobs'||payload.async===true)return send(res,202,{job:created.job,reused:created.reused,status_url:`/v1/jobs/${encodeURIComponent(created.job.id)}`});
        const finished=await jobs.waitFor(created.job.id,Math.max(1000,Number(payload.timeout)||240000)+30000);
        if(finished.status!=='completed')return send(res,finished.status==='cancelled'?409:502,{...openAiError(finished.error||finished.status,'provider_error'),gateway:finished});
        if(payload.stream===true)return streamCompletion(res,finished);
        return send(res,200,openAi(finished));
      }
      return send(res,404,openAiError('not found','invalid_request_error','not_found'));
    }catch(error){const status=error.code==='REQUEST_ID_CONFLICT'?409:/unknown provider|messages must|request_id|JSON|provider is required/.test(error.message)?400:500;return send(res,status,openAiError(error.message,'gateway_error',error.code||null));}
  });
}
