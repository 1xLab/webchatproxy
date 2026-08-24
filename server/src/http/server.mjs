import crypto from 'node:crypto';
import http from 'node:http';

function send(res,status,payload){const body=JSON.stringify(payload);res.writeHead(status,{'content-type':'application/json; charset=utf-8','content-length':Buffer.byteLength(body),'cache-control':'no-store'});res.end(body);}
async function readJson(req){let body='';for await(const c of req){body+=c;if(body.length>2*1024*1024)throw new Error('request_body_too_large');}return body.trim()?JSON.parse(body):{};}
function authorized(req,token){if(!token)return true;const supplied=String(req.headers.authorization||'').replace(/^Bearer\s+/i,'');const a=Buffer.from(supplied),b=Buffer.from(token);return a.length===b.length&&a.length>0&&crypto.timingSafeEqual(a,b);}
function openAi(job){return {id:`chatcmpl-${job.id}`,object:'chat.completion',created:Math.floor(new Date(job.created_at).getTime()/1000),model:job.model||'unknown',choices:[{index:0,message:{role:'assistant',content:job.result?.content||''},finish_reason:job.result?.finish_reason||null}],usage:job.usage||{prompt_tokens:0,completion_tokens:0,total_tokens:0},gateway:{job_id:job.id,provider:job.provider,conversation_id:job.conversation_id,status:job.status}};}

export function createHttpServer({registry,jobs,token=''}){
  return http.createServer(async(req,res)=>{
    try{
      const url=new URL(req.url||'/',`http://${req.headers.host||'localhost'}`);
      if(req.method==='GET'&&url.pathname==='/health')return send(res,200,{service:'webchatproxy',ok:true,providers:registry.ids(),jobs:jobs.stats()});
      if(!authorized(req,token))return send(res,401,{error:{message:'unauthorized',type:'authentication_error',code:'invalid_api_key'}});
      if(req.method==='GET'&&url.pathname==='/v1/providers')return send(res,200,{object:'list',data:registry.describe()});
      if(req.method==='GET'&&url.pathname==='/v1/models'){
        const provider=url.searchParams.get('provider'); if(!provider)return send(res,400,{error:{message:'provider is required'}});
        return send(res,200,await registry.get(provider).models());
      }
      if(req.method==='GET'&&url.pathname==='/v1/jobs')return send(res,200,{jobs:jobs.list({limit:url.searchParams.get('limit')||100}),stats:jobs.stats()});
      const match=url.pathname.match(/^\/v1\/jobs\/([^/]+)$/);
      if(match){const id=decodeURIComponent(match[1]);if(req.method==='GET'){const job=jobs.get(id);return job?send(res,200,{job}):send(res,404,{error:'job_not_found'});}if(req.method==='DELETE'){const job=await jobs.cancel(id);return job?send(res,200,{job}):send(res,404,{error:'job_not_found'});}}
      if(req.method==='POST'&&(url.pathname==='/v1/jobs'||url.pathname==='/v1/chat/completions')){
        const payload=await readJson(req); const requestId=req.headers['idempotency-key']||payload.request_id||null; const created=await jobs.create(payload,{requestId});
        if(url.pathname==='/v1/jobs'||payload.async===true)return send(res,202,{job:created.job,reused:created.reused,status_url:`/v1/jobs/${encodeURIComponent(created.job.id)}`});
        const finished=await jobs.waitFor(created.job.id,Math.max(1000,Number(payload.timeout)||240000)+30000);
        if(finished.status!=='completed')return send(res,finished.status==='cancelled'?409:502,{error:{message:finished.error||finished.status,type:'provider_error'},gateway:finished});
        return send(res,200,openAi(finished));
      }
      return send(res,404,{error:{message:'not found',type:'invalid_request_error'}});
    }catch(error){const status=error.code==='REQUEST_ID_CONFLICT'?409:/unknown provider|messages must|request_id|JSON/.test(error.message)?400:500;return send(res,status,{error:{message:error.message,type:'gateway_error',code:error.code||null}});}
  });
}
