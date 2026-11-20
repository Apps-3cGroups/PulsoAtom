import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const allowedDetails = new Set(['Tool connection error', 'Tool timeout', 'Invalid tool token', 'Tool is not active', 'Tool not found']);
export function summarizeResponse(status, headers, body, elapsedMs) {
  let value; try { value = JSON.parse(body); } catch { value = null; }
  const payload = value?.response ?? value;
  const message = payload?.error?.message ?? payload?.detail ?? '';
  const code = payload?.error?.code;
  const server = headers.get('server') || '';
  return {
    status, elapsedMs, contentType: headers.get('content-type')?.split(';')[0] || null,
    server: /^[a-z0-9/. _-]{1,80}$/i.test(server) ? server : null,
    upstreamStatus: Number.isInteger(value?.upstream_status_code) ? value.upstream_status_code : null,
    requestId: /^[a-f0-9-]{36}$/i.test(value?.request_uuid || '') ? value.request_uuid : null,
    detail: allowedDetails.has(message) ? message : null,
    errorCode: typeof code === 'string' && /^[a-z0-9_]{1,80}$/i.test(code) ? code : null,
    memoryError: typeof message === 'string' && /out.?of.?memory|insufficient memory/i.test(message),
    contextError: typeof message === 'string' && /context.{0,30}(exceed|overflow)/i.test(message),
    models: Array.isArray(payload?.data) ? payload.data.map(m=>m.id).filter(id=>typeof id==='string' && /^[\w./:@+-]{1,160}$/.test(id)).slice(0,30) : [],
    completionPresent: typeof payload?.choices?.[0]?.message?.content === 'string',
  };
}

export async function diagnoseGateway({ baseUrl, token, portalKey, profiles, fetchImpl = fetch }) {
  const url = new URL(baseUrl);
  if (!['http:','https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !token) throw Error('GATEWAY_CONFIGURATION_MISSING');
  const base = url.toString().replace(/\/$/,'');
  async function request(path, body) {
    const started = Date.now();
    try {
      const response = await fetchImpl(`${base}${path}`, {
        method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(body ? 45000 : 20000),
        headers: {'X-Gateway-Token':token,'Content-Type':'application/json',Accept:'application/json'},
        ...(body ? {body:JSON.stringify(body)} : {}),
      });
      return summarizeResponse(response.status,response.headers,await response.text(),Date.now()-started);
    } catch { return {status:null,transportError:true,elapsedMs:Date.now()-started}; }
  }
  const results = [{operation:'catalog',...await request('/v1/tools')}];
  for(const toolKey of new Set(profiles.map(p=>p.toolKey))) {
    if(!/^[a-z0-9_-]{1,100}$/i.test(toolKey))throw Error('INVALID_TOOL_KEY');
    const common={portal_key:portalKey,caller:{source:portalKey,mode:'portal',operation:'diagnostico-modelos'},query:{},timeout_ms:15000};
    const catalog=await request(`/v1/tools/${toolKey}/invoke`,{...common,method:'GET',path:'/v1/models',body:null});
    results.push({operation:'models',toolKey,...catalog});
    if(catalog.status!==200 || catalog.upstreamStatus!==200)continue;
    for(const profile of profiles.filter(p=>p.toolKey===toolKey)) {
      if(!catalog.models.includes(profile.model)){results.push({operation:'chat',profile:profile.id,model:profile.model,modelMissing:true});continue;}
      results.push({operation:'chat',profile:profile.id,model:profile.model,...await request(`/v1/tools/${toolKey}/invoke`,{
        ...common,timeout_ms:35000,method:'POST',path:'/v1/chat/completions',body:{model:profile.model,messages:[{role:'user',content:'Responde únicamente OK.'}],max_tokens:16,temperature:0,stream:false}
      })});
    }
  }
  return {checkedAt:new Date().toISOString(),gatewayOrigin:url.origin,results};
}

export async function runConfiguredDiagnostics() {
  const cwd=process.cwd();
  const dotenv=await import(pathToFileURL(resolve(cwd,'node_modules/dotenv/lib/main.js')));
  dotenv.config({path:resolve(cwd,'.env')});
  const {databaseConfig}=await import(pathToFileURL(resolve(cwd,'src/config.js')));
  const mysql=(await import(pathToFileURL(resolve(cwd,'node_modules/mysql2/promise.js')))).default;
  const db=await mysql.createConnection({...databaseConfig(),connectTimeout:5000});
  try {
    const [[row]]=await db.query("SELECT JSON_EXTRACT(payload,'$.localModelConfiguration.profiles') profiles FROM portal_settings WHERE id='settings'");
    const profiles=typeof row.profiles==='string'?JSON.parse(row.profiles):row.profiles;
    const result=await diagnoseGateway({baseUrl:process.env.GATEWAY_BASE_URL,token:process.env.AGENT_SHARED_TOKEN,portalKey:process.env.GATEWAY_PORTAL_KEY||'portal-pulso',profiles});
    console.log(JSON.stringify(result));
  } finally {await db.end();}
}
