import test from 'node:test';
import assert from 'node:assert/strict';
import {parseCallback,probeShop} from '../web/lib/shop-probe.mjs';
const state='a'.repeat(64);
const callback=path=>`https://playvalorant.com${path}#${new URLSearchParams({state,access_token:'test.access',id_token:'test.id',token_type:'Bearer',expires_in:'3600'})}`;
test('manual callback accepts localized paths and rejects foreign, mismatched and duplicate credentials',()=>{
 for(const path of ['/opt_in','/ja-jp/opt_in/','/en-us/opt_in/']) assert.equal(parseCallback(callback(path),state).accessToken,'test.access');
 for(const url of [callback('/opt_in').replace('playvalorant.com','evil.test'),callback('/wrong'),callback('/opt_in')+'&access_token=duplicate',callback('/opt_in').replace('https:','http:')]) assert.throws(()=>parseCallback(url,state));
 assert.throws(()=>parseCallback(callback('/opt_in'),'b'.repeat(64)));
 assert.throws(()=>parseCallback(callback('/opt_in'),undefined));
});
test('probe only fetches allowed endpoints and returns no tokens or account identifier',async()=>{
 const id='00000000-0000-0000-0000-000000000001',skin='00000000-0000-0000-0000-000000000002';const calls=[];
 const request=async(url,options)=>{calls.push({url,options});let data;
 if(url.endsWith('/userinfo'))data={sub:id};else if(url.includes('entitlements.'))data={entitlements_token:'test.entitlement'};else if(url.includes('riot-geo.'))data={affinities:{live:'ap'}};else if(url.endsWith('/version'))data={data:{riotClientVersion:'release-13.06-shipping-18-5590001'}};else if(url.includes('/store/'))data={SkinsPanelLayout:{SingleItemStoreOffers:[{Rewards:[{ItemID:skin}],Cost:{'85ad13f7-3d1b-5128-9eb2-7cd8ee0b5741':1775}}]}};else data={data:{displayName:'テストスキン'}};return Response.json(data);};
 const result=await probeShop(parseCallback(callback('/ja-jp/opt_in/'),state),request);
 assert.equal(result.items[0].price,1775);assert.equal(result.items[0].name,'テストスキン');
 assert.ok(!JSON.stringify(result).includes('test.'));assert.ok(!JSON.stringify(result).includes(id));
 for(const c of calls){assert.equal(c.options.redirect,'manual');assert.equal(c.options.cache,'no-store');if(new URL(c.url).hostname==='valorant-api.com')assert.equal(c.options.headers,undefined);}
 assert.equal(calls.filter(c=>c.url.includes('/store/')).length,1);
});
test('upstream failures reveal stage/status only and do not retry',async()=>{
 let count=0;
 await assert.rejects(probeShop({accessToken:'secret',idToken:'secret'},async()=>{count++;return new Response('secret body',{status:401});}),e=>e.stage==='アカウント確認'&&e.status===401&&!e.message.includes('secret'));
 assert.equal(count,1);
});
test('edge-compatible fetch refuses redirects without sending credentials to the destination',async()=>{
 let count=0;
 await assert.rejects(probeShop({accessToken:'secret',idToken:'secret'},async(url,options)=>{
  count++;if(options.redirect==='error')throw new TypeError('Invalid redirect value');
  assert.equal(options.redirect,'manual');
  return new Response(null,{status:302,headers:{Location:'https://evil.test/'}});
 }),e=>e.reason==='redirect'&&e.status===302);
 assert.equal(count,1);
});
test('transport and JSON errors are distinguishable and never disclose exception text',async()=>{
 for(const [request,reason] of [
  [async()=>{throw new DOMException('secret','TimeoutError');},'timeout'],
  [async()=>{throw new TypeError('secret');},'network-type-error'],
  [async()=>new Response('secret'), 'json'],
 ]) await assert.rejects(probeShop({accessToken:'secret',idToken:'secret'},request),e=>e.reason===reason&&!JSON.stringify(e).includes('secret'));
});
