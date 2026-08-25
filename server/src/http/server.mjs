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
function extensionPath(url){const params=new URLSearchParams(url.searchParams);params.delete('provider');const query=params.toString();return `${url.pathname}${query?`?${query}`:''}`;}
function extensionKind(path){if(path==='/v1/projects'||/^\/v1\/projects\/[^/]+(?:\/(?:files|conversations))?$/.test(path))return 'projects';if(path==='/v1/conversations'||/^\/v1\/conversations\/[^/]+(?:\/(?:messages|resume))?$/.test(path))return 'conversations';return null;}
function historyRoute(url){
  const match=url.pathname.match(/^\/v1\/history\/([^/]+)(?:\/(projects|conversations)(?:\/([^/]+)(?:\/(messages))?)?)?$/);
  if(!match)return null;
  const provider=decodeURIComponent(match[1]).trim().toLowerCase();
  if(!match[2])return {provider,path:'/v1/projects'};
  const resource=match[2]; const id=match[3] ? decodeURIComponent(match[3]) : null; const child=match[4];
  if(resource==='projects')return id
    ? {provider,path:`/v1/projects/${encodeURIComponent(id)}`}
    : {provider,path:'/v1/projects'};
  if(child)return {provider,path:`/v1/conversations/${encodeURIComponent(id)}/messages`};
  return id ? {provider,path:`/v1/conversations/${encodeURIComponent(id)}`} : {provider,path:'/v1/conversations'};
}

export function createForwardingServer({ upstream, provider, token = '' }) {
  const targetBase = String(upstream || '').replace(/\/$/, '');
  const fixedProvider = String(provider || '').trim().toLowerCase();
  return http.createServer(async (req, res) => {
    try {
      const incoming = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      const target = new URL(`${targetBase}${incoming.pathname}`);
      for (const [key, value] of incoming.searchParams) target.searchParams.append(key, value);
      if (incoming.pathname === '/v1/models') target.searchParams.set('provider', fixedProvider);
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (!['connection', 'content-length', 'host', 'transfer-encoding'].includes(key.toLowerCase()) && value != null) headers.set(key, Array.isArray(value) ? value.join(',') : value);
      }
      if (!headers.has('authorization') && token) headers.set('authorization', `Bearer ${token}`);
      let body = null;
      if (!['GET', 'HEAD'].includes(req.method || 'GET')) {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const raw = Buffer.concat(chunks);
        if (raw.length > 2 * 1024 * 1024) return send(res, 413, openAiError('request_body_too_large', 'invalid_request_error'));
        if (raw.length && headers.get('content-type')?.includes('application/json')) {
          const payload = JSON.parse(raw.toString('utf8'));
          if (payload && typeof payload === 'object' && !Array.isArray(payload) && ['/v1/chat/completions', '/v1/jobs'].includes(incoming.pathname)) {
            payload.provider = fixedProvider;
            body = JSON.stringify(payload);
          } else body = raw;
        } else body = raw;
      }
      const response = await fetch(target, { method: req.method, headers, body });
      res.writeHead(response.status, Object.fromEntries([...response.headers].filter(([key]) => !['connection', 'content-length', 'transfer-encoding'].includes(key))));
      if (!response.body) return res.end();
      for await (const chunk of response.body) res.write(chunk);
      res.end();
    } catch (error) {
      if (!res.headersSent) send(res, 502, openAiError(error.message, 'gateway_error', 'forwarding_failed'));
      else res.end();
    }
  });
}

export function createHttpServer({registry,jobs,usage=null,token='',fixedProvider=null,codex=null}){
  const facadeProvider=fixedProvider?String(fixedProvider).trim().toLowerCase():null;
  if(facadeProvider)registry.get(facadeProvider);
  return http.createServer(async(req,res)=>{
    try{
      const url=new URL(req.url||'/',`http://${req.headers.host||'localhost'}`);
      if(req.method==='GET'&&url.pathname==='/health')return send(res,200,{service:'webchatproxy',ok:true,mode:facadeProvider?'provider-facade':'universal',provider:facadeProvider,providers:registry.ids(),jobs:jobs.stats()});
      if(!authorized(req,token))return send(res,401,openAiError('unauthorized','authentication_error','invalid_api_key'));
      if(codex&&req.method==='GET'&&url.pathname==='/v1/auth/codex/start')return send(res,200,{object:'oauth.authorization',url:await codex.auth.startLogin()});
      if(codex&&req.method==='POST'&&url.pathname==='/v1/auth/codex/device/start')return send(res,200,{object:'oauth.device_authorization',...await codex.auth.startDeviceLogin()});
      if(codex&&req.method==='GET'&&url.pathname==='/v1/auth/codex/status')return send(res,200,{object:'oauth.status',...await codex.auth.status()});
      if(codex&&req.method==='POST'&&url.pathname==='/v1/auth/codex/logout'){codex.auth.close();return send(res,200,{ok:true});}
      if(req.method==='GET'&&url.pathname==='/v1/providers')return send(res,200,{object:'list',data:facadeProvider?[registry.get(facadeProvider).describe()]:registry.describe()});
      if(req.method==='GET'&&url.pathname==='/v1/history/providers')return send(res,200,facadeProvider?[registry.get(facadeProvider).describe()]:registry.describe());
      const historyCapability=url.pathname.match(/^\/v1\/history\/([^/]+)\/capabilities$/);
      if(req.method==='GET'&&historyCapability){
        const provider=decodeURIComponent(historyCapability[1]).trim().toLowerCase();
        if(facadeProvider&&provider!==facadeProvider)return send(res,404,openAiError('provider is not served by this facade','invalid_request_error','provider_not_found'));
        const adapter=registry.get(provider); return send(res,200,{provider,capabilities:adapter.capabilities||{},native_capabilities:adapter.nativeCapabilities||{}});
      }
      const history=historyRoute(url);
      if(req.method==='GET'&&history){
        if(facadeProvider&&history.provider!==facadeProvider)return send(res,404,openAiError('provider is not served by this facade','invalid_request_error','provider_not_found'));
        const adapter=registry.get(history.provider); const caps=adapter.capabilities||{};
        const isProject=history.path.startsWith('/v1/projects');
        const allowed=isProject?(caps.projects||caps.project_conversations||caps.project_files):caps.conversations;
        if(!allowed||typeof adapter.native!=='function')return send(res,501,openAiError(`${history.provider} does not expose history through the facade`,'unsupported_error','capability_not_exposed'));
        const query=new URLSearchParams(url.searchParams); query.delete('provider'); const suffix=query.toString();
        return send(res,200,await adapter.native('GET',`${history.path}${suffix?`?${suffix}`:''}`,null));
      }
      if(req.method==='GET'&&url.pathname==='/v1/models'){
        const provider=facadeProvider||url.searchParams.get('provider'); if(!provider)return send(res,400,openAiError('provider is required','invalid_request_error','provider_required'));
        return send(res,200,await registry.get(provider).models());
      }
      const extKind=extensionKind(url.pathname);
      if(extKind&&['GET','POST'].includes(req.method)){
        const provider=facadeProvider||url.searchParams.get('provider');
        if(!provider)return send(res,400,openAiError('provider is required','invalid_request_error','provider_required'));
        const adapter=registry.get(provider);
        const caps=adapter.capabilities||{};
        const allowed=extKind==='projects'?(caps.projects||caps.project_conversations||caps.project_files):caps.conversations;
        if(!allowed||typeof adapter.native!=='function')return send(res,501,openAiError(`${provider} does not expose ${extKind} through the facade`,'unsupported_error','capability_not_exposed'));
        const body=req.method==='POST'?await readJson(req):null;
        return send(res,200,await adapter.native(req.method,extensionPath(url),body));
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
        const requestTimeout=Number(payload.timeout);
        const waitTimeout=Number.isFinite(requestTimeout)&&requestTimeout>0?requestTimeout+30000:0;
        const finished=await jobs.waitFor(created.job.id,waitTimeout);
        if(finished.status!=='completed')return send(res,finished.status==='cancelled'?409:502,{...openAiError(finished.error||finished.status,'provider_error'),gateway:finished});
        if(payload.stream===true)return streamCompletion(res,finished);
        return send(res,200,openAi(finished));
      }
      return send(res,404,openAiError('not found','invalid_request_error','not_found'));
    }catch(error){const status=Number(error.status)|| (error.code==='REQUEST_ID_CONFLICT'?409:/unknown provider|messages must|request_id|JSON|provider is required/.test(error.message)?400:500);return send(res,status,openAiError(error.message,'gateway_error',error.code||null));}
  });
}
