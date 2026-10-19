import { getChatGPTUser } from '../../chatgpt-auth';
import { parseCallback, connectRiot, loadMarket, ProbeError } from '../../../lib/shop-probe.mjs';
import {accountHash,createWebCommerce,wallet,topup,CommerceError} from '../../../lib/commerce.mjs';
import {TopUpError} from '../../../../scripts/topup.mjs';
import {env} from 'cloudflare:workers';
export const dynamic = 'force-dynamic';
const cookieName = '__Host-dd-probe';
function reply(data: unknown, status = 200, cookie?: string) {
  return Response.json(data, {status, headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff', ...(cookie ? {'Set-Cookie':cookie} : {})}});
}
export async function POST(request: Request) {
  const user=await getChatGPTUser();
  if (!user) return reply({error:'ChatGPTにログインしてください。'},401);
  if (request.headers.get('origin') !== new URL(request.url).origin || !request.headers.get('content-type')?.startsWith('application/json')) return reply({error:'ショップ画面から操作してください。'},403);
  const action = new URL(request.url).searchParams.get('action');
  if (action === 'start') {
    const state = Array.from(crypto.getRandomValues(new Uint8Array(32)),v=>v.toString(16).padStart(2,'0')).join('');
    const nonce = crypto.randomUUID();
    const params = new URLSearchParams({client_id:'play-valorant-web-prod',redirect_uri:'https://playvalorant.com/opt_in',response_type:'token id_token',scope:'account openid',nonce,state});
    return reply({url:`https://auth.riotgames.com/authorize?${params.toString().replaceAll('+','%20')}`,expiresAt:Date.now()+600000},200,`${cookieName}=${state}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=600`);
  }
  const clear = `${cookieName}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`;
  if(action==='end')return reply({ok:true},200,clear);
  if (!['check','wallet','topup','quote','confirm','status'].includes(action||'')) return reply({error:'操作を確認してください。'},400);
  try {
    // Bound the streaming body; content-length alone is not trustworthy.
    const reader = request.body?.getReader();
    if (!reader) return reply({error:'URLを入力してください。'},400,clear);
    const chunks: Uint8Array[] = []; let size = 0;
    while (true) { const {done,value} = await reader.read(); if(done) break; size += value.length; if(size > 50000) {await reader.cancel(); return reply({error:'URLが長すぎます。'},413,clear);} chunks.push(value); }
    const bytes = new Uint8Array(size); let offset=0; for(const c of chunks){bytes.set(c,offset);offset+=c.length;}
    const body = JSON.parse(new TextDecoder().decode(bytes));
    const state = request.headers.get('cookie')?.split(';').map(c=>c.trim()).find(c=>c.startsWith(cookieName+'='))?.slice(cookieName.length+1);
    const client = await connectRiot(parseCallback(body.url,state));
    if(action==='check')return reply(await loadMarket(client,body.mode??'daily'));
    if(action==='wallet')return reply({wallet:await wallet(client)});
    if(action==='topup')return reply({paymentURL:await topup(client)});
    const commerce=createWebCommerce({db:env.DB,owner:user.userId,account:await accountHash(client.session.subject),client});
    if(action==='quote')return reply({quote:await commerce.quote(body.item)});
    if(action==='confirm')return reply({purchase:await commerce.confirm(body.quoteId)});
    return reply({purchase:await commerce.status()});
  } catch(error) {
    if(error instanceof CommerceError||error instanceof TopUpError)return reply({error:error.message},400);
    if(error instanceof ProbeError) return reply({ok:false,stage:error.stage,status:error.status,error:error.stage === 'URL確認' ? 'このページでログインを開始し、10分以内に戻り先URLを貼り付けてください。' : `${error.stage}で失敗しました${error.status ? `（HTTP ${error.status}）` : ''}［${error.reason}］。接続からやり直してください。`},400);
    return reply({ok:false,error:'処理を確認できませんでした。購入操作後は再送信せず、購入結果を確認してください。'},400);
  }
}
