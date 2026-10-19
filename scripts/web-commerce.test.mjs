import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {createWebCommerce,wallet,topup,VP} from '../web/lib/commerce.mjs';
import {loadMarket,shopSnapshot} from '../web/lib/shop-probe.mjs';
const item='00000000-0000-0000-0000-000000000001',offer='00000000-0000-0000-0000-000000000002',order='00000000-0000-0000-0000-000000000003',subject='00000000-0000-0000-0000-000000000004';
const SKIN='e7c63390-eda7-46e0-bb7a-a6abdacd2433',RP='e59aa87c-4cbf-517a-5983-6e81511be9b7',KC='85ca954a-41f2-ce94-9b45-8ca3dd39a00d';
function setup(){
 const sqlite=new DatabaseSync(':memory:');sqlite.exec(readFileSync(new URL('../web/drizzle/0000_empty_whiplash.sql',import.meta.url),'utf8'));
 const state={posts:0,owns:false,balance:3000,price:1775,seconds:1000,fail:false,clock:Date.now()};
 const db={prepare(sql){return {bind(...args){return {
  async first(){return sqlite.prepare(sql).get(...args)||null;},
  async run(){const result=sqlite.prepare(sql).run(...args);return {meta:{changes:Number(result.changes)}};}
 };}};}};
 const store=()=>({SkinsPanelLayout:{SingleItemOffersRemainingDurationInSeconds:state.seconds,SingleItemOffers:[offer],SingleItemStoreOffers:[{OfferID:offer,IsDirectPurchase:true,Rewards:[{ItemID:item,ItemTypeID:SKIN,Quantity:1}],Cost:{[VP]:state.price}}]}});
 const client={session:{subject,shard:'ap',accessToken:'secret',entitlement:'secret'},ctx:{base:'https://pd.ap.a.pvp.net',headers:{Authorization:'Bearer secret'}},getStore:async()=>store(),json:async(stage,url,options)=>{
   if(url.includes('/wallet/'))return{Balances:{[VP]:state.balance,[RP]:0,[KC]:3000}};
   if(url.includes('/entitlements/'))return{Entitlements:state.owns?[{ItemID:item}]:[]};
   if(url.endsWith('/order/')){state.posts++;assert.equal(sqlite.prepare("SELECT state FROM web_orders WHERE state='unknown'").get().state,'unknown');if(state.fail)throw Error('secret');state.owns=true;return{OrderID:order,Status:'COMPLETE'};}
   if(url.endsWith('/order/'+order))return{OrderID:order,Status:'COMPLETE'};
   throw Error('Unexpected URL '+url);
 }};
 const create=(owner='owner',account='account')=>createWebCommerce({db,owner,account,client,now:()=>state.clock});
 return{sqlite,db,state,client,create,store};
}
test('web purchase persists claim before one POST; confirms ownership; replay never orders again',async()=>{
 const f=setup(),c=f.create(),q=await c.quote({item,price:1775});assert.equal(f.state.posts,0);
 assert.equal((await c.confirm(q.id)).state,'complete');assert.equal(f.state.posts,1);
 assert.equal((await f.create().confirm(q.id)).state,'complete');assert.equal(f.state.posts,1);
 assert.ok(!JSON.stringify(f.sqlite.prepare('SELECT * FROM web_orders').all()).includes('secret'));
});
test('separate Workers and quote IDs serialize through an atomic D1 claim',async()=>{
 const f=setup(),a=f.create(),b=f.create();const q1=await a.quote({item,price:1775}),q2=await b.quote({item,price:1775});f.state.fail=true;
 await Promise.allSettled([a.confirm(q1.id),b.confirm(q2.id),f.create().confirm(q1.id)]);
 assert.equal(f.state.posts,1);assert.equal((await f.create().status()).state,'unknown');
 await assert.rejects(f.create().quote({item,price:1775}));assert.equal(f.state.posts,1);
 f.state.owns=true;assert.equal((await f.create().status()).state,'complete');assert.equal(f.state.posts,1);
});
test('web purchase blocks account mismatch, changed price/balance, owned item, expiry and missing DB',async()=>{
 for(const change of [f=>f.state.price++,f=>f.state.balance++,f=>f.state.owns=true,f=>f.state.seconds=10,f=>f.state.clock+=61000]){
  const f=setup(),c=f.create(),q=await c.quote({item,price:1775});change(f);await assert.rejects(c.confirm(q.id));assert.equal(f.state.posts,0);
 }
 const f=setup(),q=await f.create().quote({item,price:1775});await assert.rejects(f.create('other').confirm(q.id));await assert.rejects(f.create('owner','different-account').confirm(q.id));assert.equal(f.state.posts,0);
 assert.throws(()=>createWebCommerce({db:null,owner:'owner',account:'account',client:f.client}));
});
test('failed persistence never submits; ambiguous order responses stay blocked after recreation',async()=>{
 const f=setup(),q=await f.create().quote({item,price:1775});
 const broken={prepare(sql){if(sql.startsWith('UPDATE'))throw Error('database down');return f.db.prepare(sql);}};
 const c=createWebCommerce({db:broken,owner:'owner',account:'account',client:f.client,now:()=>f.state.clock});
 await assert.rejects(c.confirm(q.id));assert.equal(f.state.posts,0);
 f.client.json=async(stage,url)=>{if(url.includes('/wallet/'))return{Balances:{[VP]:3000,[RP]:0,[KC]:0}};if(url.includes('/entitlements/'))return{Entitlements:[]};if(url.endsWith('/order/')){f.state.posts++;return{OrderID:'bad',Status:'COMPLETE'};}throw Error();};
 assert.equal((await f.create().confirm(q.id)).state,'unknown');assert.equal((await f.create().confirm(q.id)).state,'unknown');assert.equal(f.state.posts,1);
});
test('wallet validates all currencies and web topup never follows redirects',async()=>{
 const f=setup();assert.deepEqual(await wallet(f.client),{vp:3000,rp:0,kc:3000});f.state.balance=-1;await assert.rejects(wallet(f.client));
 let calls=0;await assert.rejects(topup(f.client,async(url,options)=>{calls++;assert.equal(options.redirect,'manual');return new Response(null,{status:302,headers:{Location:'https://evil.test/'}});}));assert.equal(calls,1);
});
test('night market inactive/discounts and accessories retain safe public fields only',async()=>{
 const f=setup();f.client.json=async()=>({data:{displayName:'商品',displayIcon:'https://media.valorant-api.com/image.png',secret:'secret'}});
 f.client.getStore=async()=>({});const inactive=await loadMarket(f.client,'night');assert.equal(inactive.active,false);assert.deepEqual(shopSnapshot(inactive).items,[]);
 f.client.getStore=async()=>({BonusStore:{BonusStoreRemainingDurationInSeconds:3600,BonusStoreOffers:[{Offer:{Rewards:[{ItemID:item}],Cost:{[VP]:1775}},DiscountCosts:{[VP]:1065},DiscountPercent:40}]}});
 const night=await loadMarket(f.client,'night');assert.equal(night.items[0].discountPercent,40);assert.equal(shopSnapshot(night).items[0].originalPrice,1775);
 f.client.getStore=async()=>({AccessoryStore:{AccessoryStoreRemainingDurationInSeconds:86400,AccessoryStoreOffers:[{Offer:{OfferID:offer,IsDirectPurchase:true,Rewards:[{ItemID:item,ItemTypeID:'de7caa6b-adf7-4588-bbd1-143831e786c6',Quantity:1}],Cost:{[KC]:2500}}}]}});
 const accessory=await loadMarket(f.client,'accessory');assert.equal(accessory.currency,'KC');assert.equal(shopSnapshot(accessory).items[0].typeLabel,'プレイヤータイトル');assert.ok(!JSON.stringify(accessory).includes('secret'));
 await assert.rejects(loadMarket(f.client,'unknown'));
});
