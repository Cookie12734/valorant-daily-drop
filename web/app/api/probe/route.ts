import { getChatGPTUser } from '../../chatgpt-auth';
import { parseCallback, probeShop, ProbeError } from '../../../lib/shop-probe.mjs';
export const dynamic = 'force-dynamic';
const cookieName = '__Host-dd-probe';
function reply(data: unknown, status = 200, cookie?: string) {
  return Response.json(data, {status, headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff', ...(cookie ? {'Set-Cookie':cookie} : {})}});
}
export async function POST(request: Request) {
  if (!await getChatGPTUser()) return reply({error:'ChatGPTにログインしてください。'},401);
  if (request.headers.get('origin') !== new URL(request.url).origin || !request.headers.get('content-type')?.startsWith('application/json')) return reply({error:'検証ページから操作してください。'},403);
  const action = new URL(request.url).searchParams.get('action');
  if (action === 'start') {
    const state = Array.from(crypto.getRandomValues(new Uint8Array(32)),v=>v.toString(16).padStart(2,'0')).join('');
    const nonce = crypto.randomUUID();
    const params = new URLSearchParams({client_id:'play-valorant-web-prod',redirect_uri:'https://playvalorant.com/opt_in',response_type:'token id_token',scope:'account openid',nonce,state});
    return reply({url:`https://auth.riotgames.com/authorize?${params.toString().replaceAll('+','%20')}`},200,`${cookieName}=${state}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=600`);
  }
  if (action !== 'check') return reply({error:'操作を確認してください。'},400);
  const clear = `${cookieName}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`;
  try {
    // Bound the streaming body; content-length alone is not trustworthy.
    const reader = request.body?.getReader();
    if (!reader) return reply({error:'URLを入力してください。'},400,clear);
    const chunks: Uint8Array[] = []; let size = 0;
    while (true) { const {done,value} = await reader.read(); if(done) break; size += value.length; if(size > 50000) {await reader.cancel(); return reply({error:'URLが長すぎます。'},413,clear);} chunks.push(value); }
    const bytes = new Uint8Array(size); let offset=0; for(const c of chunks){bytes.set(c,offset);offset+=c.length;}
    const body = JSON.parse(new TextDecoder().decode(bytes));
    const state = request.headers.get('cookie')?.split(';').map(c=>c.trim()).find(c=>c.startsWith(cookieName+'='))?.slice(cookieName.length+1);
    const result = await probeShop(parseCallback(body.url,state));
    return reply(result,200,clear);
  } catch(error) {
    if(error instanceof ProbeError) return reply({ok:false,stage:error.stage,status:error.status,error:error.stage === 'URL確認' ? 'このページでログインを開始し、10分以内に戻り先URLを貼り付けてください。' : `${error.stage}で失敗しました${error.status ? `（HTTP ${error.status}）` : '（通信または応答形式）'}。再検証する場合は最初からログインしてください。`},400,clear);
    return reply({ok:false,error:'入力を処理できませんでした。最初から検証してください。'},400,clear);
  }
}
