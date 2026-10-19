import {clientPaymentURL} from '../../scripts/topup.mjs';
export const VP='85ad13f7-3d1b-5128-9eb2-7cd8ee0b5741';
const RP='e59aa87c-4cbf-517a-5983-6e81511be9b7',KC='85ca954a-41f2-ce94-9b45-8ca3dd39a00d';
const SKIN='e7c63390-eda7-46e0-bb7a-a6abdacd2433';
const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
export class CommerceError extends Error {}
export async function wallet(client){
 const data=await client.json('残高確認',`${client.ctx.base}/store/v1/wallet/${client.session.subject}`,{headers:client.ctx.headers});
 const amounts=[VP,RP,KC].map(id=>data?.Balances?.[id]);
 if(amounts.some(v=>!Number.isSafeInteger(v)||v<0))throw new CommerceError('残高を確認できません。');
 return {vp:amounts[0],rp:amounts[1],kc:amounts[2]};
}
export function topup(client,request=fetch){
 // Desktop helper uses redirect:error; Workers require manual plus rejection.
 return clientPaymentURL(client.session,{remote:async(url,options)=>{
   const response=await request(url,{...options,redirect:'manual',cache:'no-store'});
   if(response.status>=300&&response.status<400)throw new CommerceError('決済サービスの転送を拒否しました。');
   return response;
 }});
}
export async function accountHash(subject){
 const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(subject.toLowerCase()));
 return Array.from(new Uint8Array(digest),v=>v.toString(16).padStart(2,'0')).join('');
}
const unresolved=record=>record&&['unknown','pending'].includes(record.state);
function result(record){
 const messages={idle:'未確認の購入はありません。',quote:'購入確認待ちです。',unknown:'購入結果が未確認です。再送信せず「購入結果を確認」を押してください。',pending:'購入を処理中です。「購入結果を確認」を押してください。',complete:'スキンの所持を確認しました。',failed:'購入は完了していません。商品と価格を改めて確認してください。'};
 return {state:record?.state||'idle',message:messages[record?.state||'idle']};
}
export function createWebCommerce({db,owner,account,client,now=Date.now}){
 if(!db)throw new CommerceError('購入記録に接続できないため、購入できません。');
 const first=(sql,...args)=>db.prepare(sql).bind(...args).first();
 const run=(sql,...args)=>db.prepare(sql).bind(...args).run();
 async function owned(item){
   const data=await client.json('所持確認',`${client.ctx.base}/store/v1/entitlements/${client.session.subject}/${SKIN}`,{headers:client.ctx.headers});
   if(!Array.isArray(data?.Entitlements)||data.Entitlements.some(x=>!uuid.test(x?.ItemID)))throw new CommerceError('所持状態を確認できません。');
   return data.Entitlements.some(x=>x.ItemID.toLowerCase()===item);
 }
 async function inspect(item,price){
   const store=await client.getStore(),panel=store?.SkinsPanelLayout;
   if(!Number.isSafeInteger(panel?.SingleItemOffersRemainingDurationInSeconds)||panel.SingleItemOffersRemainingDurationInSeconds<120||!Array.isArray(panel.SingleItemStoreOffers)||panel.SingleItemStoreOffers.length>4)throw new CommerceError('更新直前、または商品を確認できないため購入できません。');
   const matches=panel.SingleItemStoreOffers.filter(o=>o?.Rewards?.some(r=>r.ItemID?.toLowerCase()===item));
   const offer=matches[0];
   if(matches.length!==1||!uuid.test(offer?.OfferID)||offer.IsDirectPurchase!==true||!panel.SingleItemOffers?.includes(offer.OfferID)||offer.Rewards.length!==1||offer.Rewards[0].ItemTypeID!==SKIN||offer.Rewards[0].Quantity!==1||!offer.Cost||Object.keys(offer.Cost).length!==1||offer.Cost[VP]!==price)throw new CommerceError('商品または価格が変わりました。ショップを再取得してください。');
   const balance=(await wallet(client)).vp;
   if(balance<price)throw new CommerceError(`VPが${price-balance}不足しています。`);
   if(await owned(item))throw new CommerceError('このスキンは既に所持しています。');
   return {offer:offer.OfferID,balance};
 }
 async function reconcile(record){
   if(!unresolved(record))return result(record);
   try{
     let state=record.state;
     if(record.order_id){
       const order=await client.json('購入結果確認',`${client.ctx.base}/store/v1/order/${record.order_id}`,{headers:client.ctx.headers});
       if(order?.OrderID!==record.order_id||!['ACCEPTED','COMPLETE','FAILED'].includes(order.Status))throw Error();
       if(order.Status==='FAILED')state='failed';
       else if(order.Status==='COMPLETE'&&await owned(record.item))state='complete';
     }else if(await owned(record.item))state='complete';
     if(state!==record.state)await run("UPDATE web_orders SET state=? WHERE id=? AND owner=? AND account=? AND state IN ('unknown','pending')",state,record.id,owner,account);
   }catch{/* Unknown remains durable, never authorizing a resend. */}
   return result(await first('SELECT * FROM web_orders WHERE id=? AND owner=? AND account=?',record.id,owner,account));
 }
 return {
   async quote(input){
     if(!uuid.test(input?.item??'')||!Number.isSafeInteger(input?.price)||input.price<=0)throw new CommerceError('購入する商品を確認してください。');
     if(await first("SELECT id FROM web_orders WHERE account=? AND state IN ('unknown','pending')",account))throw new CommerceError('前回の購入結果が未確認です。先に購入結果を確認してください。');
     const item=input.item.toLowerCase(),{offer,balance}=await inspect(item,input.price),id=crypto.randomUUID(),created=now(),expires=created+60000;
     await run('INSERT INTO web_orders (id,owner,account,item,offer,price,balance,expires,created,state) VALUES (?,?,?,?,?,?,?,?,?,?)',id,owner,account,item,offer,input.price,balance,expires,created,'quote');
     return {id,item,price:input.price,balance,expiresAt:new Date(expires).toISOString(),currency:'VP'};
   },
   async confirm(id){
     if(!uuid.test(id??''))throw new CommerceError('購入確認情報が不正です。');
     const record=await first('SELECT * FROM web_orders WHERE id=? AND owner=? AND account=?',id,owner,account);
     if(!record)throw new CommerceError('購入確認情報が一致しません。');
     if(record.state!=='quote')return reconcile(record);
     if(record.expires<=now())throw new CommerceError('確認の有効期限が切れました。もう一度確認してください。');
     const live=await inspect(record.item,record.price);
     if(live.offer!==record.offer||live.balance!==record.balance)throw new CommerceError('商品または残高が変わりました。もう一度確認してください。');
     // Atomic claim + partial unique index serialize all Workers/tabs for this Riot account.
     let claim;
     try{claim=await run("UPDATE web_orders SET state='unknown' WHERE id=? AND owner=? AND account=? AND state='quote' AND expires>?",id,owner,account,now());}
     catch{throw new CommerceError('購入を開始できません。先に購入結果を確認してください。');}
     if(claim.meta?.changes!==1)return this.status();
     try{
       // Exactly one POST. A crash or any ambiguous response leaves a durable block.
       const order=await client.json('購入送信',`${client.ctx.base}/store/v1/order/`,{method:'POST',headers:client.ctx.headers,body:JSON.stringify({XID:id,OfferID:record.offer})});
       if(!uuid.test(order?.OrderID)||!['ACCEPTED','COMPLETE','FAILED'].includes(order.Status))throw Error();
       await run("UPDATE web_orders SET order_id=?,state=? WHERE id=? AND state='unknown'",order.OrderID,order.Status==='FAILED'?'failed':'pending',id);
     }catch{}
     return reconcile(await first('SELECT * FROM web_orders WHERE id=? AND owner=? AND account=?',id,owner,account));
   },
   async status(){
     const record=await first("SELECT * FROM web_orders WHERE owner=? AND account=? AND state IN ('unknown','pending') ORDER BY created DESC LIMIT 1",owner,account)
       ||await first("SELECT * FROM web_orders WHERE owner=? AND account=? AND state IN ('complete','failed') ORDER BY created DESC LIMIT 1",owner,account);
     return reconcile(record);
   },
 };
}
