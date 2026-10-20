'use client';
import {useEffect,useRef,useState} from 'react';
import {shopSnapshot,parseCallback} from '../lib/shop-probe.mjs';
type Mode='daily'|'night'|'accessory';
type Item={id:string;name:string;price:number;image:string|null;originalPrice?:number;discountPercent?:number;typeLabel?:string};
type Snapshot={ok:boolean;mode:Mode;items:Item[];checkedAt:string;expiresAt:string|null;currency:string;active:boolean};
type Quote={id:string;item:string;price:number;balance:number;expiresAt:string;currency:string;name:string};
type Purchase={state:string;message:string};
type APIResponse={error?:string;quote:Omit<Quote,'name'>;purchase:Purchase;wallet:{vp:number;rp:number;kc:number};paymentURL:string};
const labels:Record<Mode,string>={daily:'デイリーショップ',night:'ナイトマーケット',accessory:'アクセサリー'};
const formatDate=(date:string)=>new Date(date).toLocaleString('ja-JP',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'});
export default function Shop({storageKey}:{storageKey:string}){
 const [shops,setShops]=useState<Partial<Record<Mode,Snapshot>>>({}),[mode,setMode]=useState<Mode>('daily'),[ready,setReady]=useState(false);
 const [phase,setPhase]=useState<'idle'|'starting'|'login'|'checking'>('idle'),[login,setLogin]=useState(''),[value,setValue]=useState('');
 const [busy,setBusy]=useState(''),[error,setError]=useState(''),[notice,setNotice]=useState(''),[now,setNow]=useState(0),[online,setOnline]=useState(true);
 const [connected,setConnected]=useState(false),[wallet,setWallet]=useState<{vp:number;rp:number;kc:number}|null>(null);
 const [quote,setQuote]=useState<Quote|null>(null),[purchase,setPurchase]=useState<Purchase|null>(null),[paymentURL,setPaymentURL]=useState('');
 const auth=useRef<{url:string;expires:number}|null>(null),loginExpires=useRef(0),lock=useRef(false);
 const heading=useRef<HTMLHeadingElement>(null),confirmation=useRef<HTMLDivElement>(null),callbackInput=useRef<HTMLInputElement>(null);
 const pendingKey=storageKey+':pending';
 const shop=shops[mode];
 useEffect(()=>{
   const cached:Partial<Record<Mode,Snapshot>>={};
   for(const key of ['daily','night','accessory'] as Mode[])try{const data=shopSnapshot(JSON.parse(localStorage.getItem(storageKey+':'+key)||(key==='daily'?localStorage.getItem(storageKey):null)||'null'));if(data&&data.mode===key)cached[key]=data as Snapshot;}catch{}
   setShops(cached);setReady(true);
   try{const expires=Number(sessionStorage.getItem(pendingKey));if(expires>Date.now()){loginExpires.current=expires;setPhase('login');}}catch{}
   const update=()=>{const time=Date.now();setNow(time);setOnline(navigator.onLine);if(auth.current&&auth.current.expires<=time){auth.current=null;setConnected(false);setQuote(null);setPaymentURL('');setWallet(null);setNotice('接続の有効期限が切れました。Riotに再接続してください。');}};
   update();const timer=setInterval(update,1000);window.addEventListener('online',update);window.addEventListener('offline',update);
   return()=>{clearInterval(timer);window.removeEventListener('online',update);window.removeEventListener('offline',update);auth.current=null;};
 },[storageKey,pendingKey]);
 useEffect(()=>{if(quote)confirmation.current?.focus();},[quote]);
 function clearPending(){try{sessionStorage.removeItem(pendingKey);}catch{}setLogin('');setValue('');}
 function clearConnection(){auth.current=null;setConnected(false);setWallet(null);setQuote(null);setPaymentURL('');setPurchase(null);}
 async function request(action:string,body:Record<string,unknown>={}){
   if(!auth.current||auth.current.expires<=Date.now())throw Error('接続の有効期限が切れました。Riotに再接続してください。');
   const response=await fetch('/api/probe?action='+action,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...body,url:auth.current.url}),cache:'no-store'});
   if(response.status===401)throw Error('サイトへのログインが切れました。ページを開き直してください。');
   let data:APIResponse;try{data=await response.json() as APIResponse;}catch{throw Error('サーバーの応答を確認できません。購入後は再送信せず、購入結果を確認してください。');}
   if(!response.ok)throw Error(data.error||'処理を確認できませんでした。');return data;
 }
 async function run(name:string,action:()=>Promise<void>){
   if(lock.current)return;lock.current=true;setBusy(name);setError('');setNotice('');
   try{await action();}catch(e){setError(e instanceof Error?e.message:'通信に失敗しました。購入後は購入結果を確認してください。');}
   finally{lock.current=false;setBusy('');}
 }
 function save(data:unknown){
   const snapshot=shopSnapshot(data) as Snapshot|null;if(!snapshot)throw Error('ショップの形式を確認できませんでした。');
   setShops(previous=>({...previous,[snapshot.mode]:snapshot}));setNow(Date.now());
   try{localStorage.setItem(storageKey+':'+snapshot.mode,JSON.stringify(snapshot));}catch{setNotice('ショップを取得しました。このブラウザーでは端末保存できません。');}
 }
 async function start(){await run('ログイン準備',async()=>{
   setPhase('starting');clearConnection();clearPending();
   try{const response=await fetch('/api/probe?action=start',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}',cache:'no-store'});
     const data=await response.json() as {url?:string;expiresAt?:number};
     if(!response.ok||!data.url||!data.expiresAt)throw Error('ログインを開始できませんでした。ページを開き直してください。');
     loginExpires.current=data.expiresAt;setLogin(data.url);setPhase('login');try{sessionStorage.setItem(pendingKey,String(data.expiresAt));}catch{}
   }catch(e){setPhase('idle');throw e;}
 });}
 async function connectCallback(raw:string){
   const callback=raw.trim();
   // Check the clipboard locally before sending anything; the server still binds state to its cookie.
   try{const state=new URLSearchParams(new URL(callback).hash.slice(1)).get('state');parseCallback(callback,state);}
   catch{throw Error('Riotの認証後URLが見つかりません。ログイン後の404画面でアドレス全体をコピーしてください。');}
   setValue('');
   setPhase('checking');auth.current={url:callback,expires:loginExpires.current};
   try{save(await request('check',{mode}));setConnected(true);setNotice('接続しました。タブを閉じるか、開始から10分経つと再接続が必要です。');heading.current?.focus();}
   catch(e){clearConnection();throw e;}finally{clearPending();setPhase('idle');}
 }
 async function check(event:React.FormEvent){event.preventDefault();await run('ショップ取得',()=>connectCallback(value));}
 async function pasteAndConnect(){await run('貼り付け・接続',async()=>{
   let text='';
   try{
     if(!navigator.clipboard?.readText)throw Error();
     // Call directly from the click gesture; never read on page load or focus.
     text=await navigator.clipboard.readText();
   }catch{
     callbackInput.current?.focus();
     throw Error('クリップボードを読み取れませんでした。下の入力欄を長押しして貼り付け、「接続してショップを取得」を押してください。');
   }
   try{await connectCallback(text);}finally{text='';}
 });}
 async function choose(next:Mode){if(lock.current)return;setMode(next);setQuote(null);setPaymentURL('');setError('');if(connected)await run('ショップ取得',async()=>{save(await request('check',{mode:next}));});}
 async function disconnect(){await run('接続終了',async()=>{clearConnection();clearPending();setPhase('idle');await fetch('/api/probe?action=end',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}',cache:'no-store'});setNotice('接続を終了しました。保存したショップは引き続き確認できます。');});}
 async function purchaseQuote(item:Item){setQuote(null);await run('価格・所持確認',async()=>{const data=await request('quote',{item:{item:item.id,price:item.price,mode}});setQuote({...data.quote,name:item.name});});}
 async function applyPurchase(result:Purchase){
   setPurchase(result);if(result.state!=='complete')return;
   try{setWallet((await request('wallet')).wallet);}catch{setNotice('購入結果を取得しました。残高は手動で更新してください。');}
   if(mode==='accessory')try{save(await request('check',{mode}));}catch{setNotice('購入結果を取得しました。残高とアクセサリーは手動で再取得してください。');}
 }
 async function confirm(){const selected=quote;if(!selected)return;setQuote(null);await run('購入送信',async()=>{
   // Once submitted, never restore a confirm button, including on network errors.
   setPurchase({state:'unknown',message:'購入結果を確認中です。通信が切れた場合は「購入結果を確認」を押してください。'});
   await applyPurchase((await request('confirm',{quoteId:selected.id})).purchase);
 });}
 async function topup(){setPaymentURL('');await run('VP購入画面の準備',async()=>{
   const data=await request('topup');let url;try{url=new URL(data.paymentURL);}catch{throw Error('決済URLを確認できません。');}
   if(url.origin!=='https://pmc.pay.riotgames.com'||url.pathname!=='/start'||url.username||url.password)throw Error('決済URLを確認できません。');
   setPaymentURL(url.href);
 });}
 function forget(){try{for(const key of ['',':daily',':night',':accessory'])localStorage.removeItem(storageKey+key);}catch{setError('保存データを消去できませんでした。ブラウザーのサイトデータ設定から削除してください。');return;}setShops({});setNotice('端末に保存したショップを消去しました。サーバーの購入記録は二重送信防止のため保持します。');}
 const remaining=shop?.expiresAt?Math.max(0,Math.ceil((Date.parse(shop.expiresAt)-now)/1000)):null;
 const expired=remaining===0;
 const clock=remaining===null?'期限不明':[Math.floor(remaining/3600),Math.floor(remaining%3600/60),remaining%60].map(v=>String(v).padStart(2,'0')).join(' : ');
 const disabled=!!busy||!online||!connected;
 const unresolved=purchase&&['unknown','pending'].includes(purchase.state);
 return <>
  <a className="skip-link" href="#main">ショップへ移動</a>
  <header className="header"><a className="brand" href="/" aria-label="DAILY DROP ホーム"><svg width="32" height="32" viewBox="0 0 32 32" aria-hidden="true"><path d="M5 4h9l13 13v11h-9L5 15z" fill="currentColor"/><path d="m14 4 13 13h-9L5 4" fill="var(--bg)"/></svg><span>DAILY<span className="brand-light">DROP</span><small>VALORANT SHOP VIEWER</small></span></a><a className="help-link" href="#help">使い方</a></header>
  <main id="main" className="page">
   <div className="page-heading"><div><p className="eyebrow">YOUR DAILY SELECTION</p><h1 ref={heading} tabIndex={-1}>{labels[mode]}<span className="accent">.</span></h1></div>{shop?.active&&<div className="countdown"><span>{expired?'更新時刻を過ぎています':'ショップ更新まで'}</span><strong>{clock}</strong><small>{shop.expiresAt?formatDate(shop.expiresAt)+' 更新予定':'再取得して確認してください'}</small></div>}</div>
   <div className="market-switch" role="group" aria-label="表示するショップ">{(['daily','night','accessory'] as Mode[]).map(key=><button key={key} className={mode===key?'':'quiet'} aria-pressed={mode===key} disabled={!!busy} onClick={()=>choose(key)}>{key==='daily'?'ショップ':labels[key]}</button>)}</div>
   {!online&&<p className="notice" role="status">オフラインです。新しい取得や購入にはインターネット接続が必要です。</p>}
   <section className="shop-section" aria-labelledby="offers-title">
    <div className="toolbar"><h2 id="offers-title"><span className="marker"/>{labels[mode]} <span className="muted">{shop?String(shop.items.length).padStart(2,'0'):'—'}</span></h2><span className="small">{shop?'最終取得 '+formatDate(shop.checkedAt):'PCの起動は不要'}</span></div>
    {expired&&<p className="notice">前回取得したショップです。再取得して現在の商品を確認してください。</p>}
    {shop?.active&&!shop.expiresAt&&<p className="notice">更新期限が不明です。最終取得時点の内容を表示しています。</p>}
    {shop?.items.length?<div className={'offers'+(expired?' expired':'')}>{shop.items.map((item,i)=><article className="offer" key={item.id}><div className="offer-art"><span className="offer-number">{String(i+1).padStart(2,'0')}{item.discountPercent!==undefined&&` / ${item.discountPercent}% OFF`}</span>{item.image?<img src={item.image} alt="" referrerPolicy="no-referrer" onError={e=>{e.currentTarget.hidden=true;}}/>:<span className="muted">{item.typeLabel==='プレイヤータイトル'?'TITLE':'画像なし'}</span>}</div><div className="offer-info"><h3>{item.name}</h3>{item.typeLabel&&<p className="small">{item.typeLabel}</p>}{item.originalPrice!==undefined&&<del className="small">{item.originalPrice.toLocaleString()} VP</del>}<p className="price">{item.price.toLocaleString()} <span>{shop.currency}</span></p>{mode!=='night'&&<button className="quiet buy-button" disabled={disabled||expired||remaining===null||!!unresolved} onClick={()=>purchaseQuote(item)}>購入内容を確認</button>}</div></article>)}</div>:<div className="empty"><span className="empty-mark" aria-hidden="true">↗</span><h2>{!ready?'読み込んでいます…':shop?mode==='night'?'ナイトマーケットは開催されていません':'表示できる商品がありません':`${labels[mode]}を確認しましょう`}</h2><p>{shop?'最終取得時点の情報です。再取得で最新の状態を確認できます。':'Riotに接続すると、商品と価格が表示されます。'}</p></div>}
    {mode==='night'&&<p className="small">ナイトマーケットは閲覧に対応しています。</p>}
   </section>
   <section className="account-tools" aria-label="残高と購入"><div className="toolbar"><h2>残高と購入</h2><span className="small">{connected?'接続中 · 開始から10分間':'操作するにはRiotへ接続してください'}</span></div>
    <div className="wallet"><span>VP <strong>{wallet?wallet.vp.toLocaleString():'—'}</strong></span><span>RP <strong>{wallet?wallet.rp.toLocaleString():'—'}</strong></span><span>KC <strong>{wallet?wallet.kc.toLocaleString():'—'}</strong></span></div>
    <div className="tool-buttons"><button className="quiet" disabled={disabled} onClick={()=>run('残高取得',async()=>setWallet((await request('wallet')).wallet))}>残高を更新</button><button disabled={disabled} onClick={topup}>VPを購入</button><button className="quiet" disabled={disabled} onClick={()=>run('購入結果確認',async()=>applyPurchase((await request('status')).purchase))}>購入結果を確認</button></div>
    {paymentURL&&<div className="notice"><p>Riot公式の決済ページで金額・支払方法を選び、購入を確定してください。この画面では課金しません。</p><a className="button" href={paymentURL} target="_blank" rel="noreferrer">RiotのVP購入画面を開く ↗</a><p className="small">戻ったら「残高を更新」を押してください。反映が遅い場合は追加購入せずお待ちください。</p></div>}
    {quote&&<div className="purchase-confirm" ref={confirmation} tabIndex={-1} role="region" aria-label="商品購入の確認"><h2>この商品を購入しますか？</h2><p>{quote.name}</p><strong>{quote.price.toLocaleString()} {quote.currency}</strong><p>残高 {quote.balance.toLocaleString()} {quote.currency} → 購入後 {(quote.balance-quote.price).toLocaleString()} {quote.currency}</p><p className="small">確認の有効期限：{formatDate(quote.expiresAt)}。確定すると{quote.currency}を消費します。</p>{quote.currency==='KC'&&<p className="small">KCで購入した商品は返金対象外です。</p>}<div className="tool-buttons"><button className="primary" disabled={disabled||Date.parse(quote.expiresAt)<=now} onClick={confirm}>{quote.price.toLocaleString()} {quote.currency}で購入を確定</button><button className="quiet" disabled={!!busy} onClick={()=>setQuote(null)}>キャンセル</button></div>{Date.parse(quote.expiresAt)<=now&&<p>有効期限が切れました。キャンセルして商品を選び直してください。</p>}</div>}
    {purchase&&<p className="notice" role="status">{purchase.message}</p>}
   </section>
   <div className="operation-status" aria-live="polite">{busy&&<p role="status">{busy}中…</p>}{notice&&<p role="status">{notice}</p>}{error&&<p className="error" role="alert">{error}</p>}</div>
   <section className="connection" aria-labelledby="connect-title"><div><p className="eyebrow">RIOT ACCOUNT</p><h2 id="connect-title">{connected?'Riotに接続中':'Riotに接続する'}</h2><p>公式ログイン後のURLを貼り付けます。<br/>パスワードはRiotの画面で入力してください。</p></div><div className="connection-actions">
    {connected?<><button disabled={disabled} onClick={()=>run('ショップ取得',async()=>save(await request('check',{mode})))}>表示中のショップを再取得</button><button className="quiet" disabled={!!busy} onClick={disconnect}>接続を終了</button></>:phase==='idle'||phase==='starting'?<><button className="primary" onClick={start} disabled={!ready||!!busy||!online}>{phase==='starting'?'準備しています…':'Riotログインを準備'}</button><p className="small">接続は開始から10分間。ページを閉じると再接続が必要です。</p></>:<>
     <ol className="steps"><li><strong>Riot公式ページでログイン</strong>{login?<a className="button primary" href={login} target="_blank" rel="noreferrer">Riot公式ログインを開く ↗</a>:<p>ログイン済みなら下にURLを貼り付けてください。未完了なら「やり直す」を押してください。</p>}</li><li><strong>認証後のURLをコピー</strong><p>404画面でも、アドレス全体をコピー。この画面へ戻り、開始から10分以内に貼り付けます。</p></li></ol>
     <form onSubmit={check}><button type="button" disabled={!!busy||!online} onClick={pasteAndConnect}>貼り付けて接続</button><p className="small">認証後のURLをコピーしてから押してください。貼り付けの許可が表示されたら許可すると、そのまま接続します。</p><label htmlFor="callback">認証後のURL</label><input ref={callbackInput} id="callback" type="password" autoComplete="off" spellCheck={false} autoCapitalize="none" maxLength={40000} value={value} onChange={e=>setValue(e.target.value)} disabled={!!busy} placeholder="ここに貼り付け（内容は非表示）" aria-describedby="credential-note"/><p className="small" id="credential-note">認証URLはこのタブのメモリー内だけに保持し、取得・購入操作の際に非公開サーバーへ送信します。他の人に共有しないでください。</p><button type="submit" disabled={!!busy||!online||!value.trim()}>接続してショップを取得</button><button className="quiet" type="button" disabled={!!busy} onClick={()=>{clearPending();setPhase('idle');setError('');}}>やり直す</button></form>
    </>}
   </div></section>
   <section className="help" id="help"><h2>使い方と保存について</h2><details><summary>ホーム画面から開く</summary><p>Braveではこのサイトをお気に入りに登録し、iPhoneのホーム画面にBraveウィジェットを追加できます。独立したWebアプリとして使う場合はSafariで開き、共有メニューから「ホーム画面に追加」を選んでください。</p><p>ブラウザーとホーム画面のアプリではログインや保存内容が共有されない場合があります。使うアプリ側でログインを始め、認証後はそのアプリに戻ってURLを貼り付けてください。</p></details><details><summary>保存と購入のしくみ</summary><p>商品情報だけをこの端末に保存します。認証URLは接続中のタブのメモリーだけに保持し、接続終了・ページ再読み込み・期限切れで破棄します。サーバーのDB・ファイル・ログには認証情報を保存しません。</p><p>二重購入を防ぐため、サーバーにはアカウントのハッシュ、購入確認内容、注文IDと結果を記録します。通信が切れた場合は購入をやり直さず「購入結果を確認」を押してください。</p><p>通常ショップのスキンをVP、アクセサリーをKCで購入できます。KCで購入した商品は返金対象外です。ナイトマーケットは閲覧のみです。VP購入の金額選択・支払いはRiot公式ページで行います。自動ログイン・バックグラウンド更新・オフライン起動には対応していません。</p><button className="quiet" disabled={!!busy} onClick={forget}>保存したショップを消去</button></details></section>
  </main><footer>DAILY DROP <span>非公式のVALORANTショップビューアー。Riot Gamesとは提携していません。</span></footer>
 </>;
}
