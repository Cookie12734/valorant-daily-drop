'use client';
import {useEffect,useRef,useState} from 'react';
import {shopSnapshot} from '../lib/shop-probe.mjs';

type Snapshot={ok:boolean;items:{id:string;name:string;price:number;image:string|null}[];checkedAt:string;expiresAt:string|null};
type Phase='idle'|'starting'|'login'|'checking';
const formatDate=(date:string)=>new Date(date).toLocaleString('ja-JP',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'});

export default function Shop({storageKey}:{storageKey:string}){
  const [shop,setShop]=useState<Snapshot|null>(null),[ready,setReady]=useState(false);
  const [phase,setPhase]=useState<Phase>('idle'),[login,setLogin]=useState(''),[value,setValue]=useState('');
  const [error,setError]=useState(''),[notice,setNotice]=useState(''),[now,setNow]=useState(0),[online,setOnline]=useState(true);
  const resultHeading=useRef<HTMLHeadingElement>(null);
  const pendingKey=storageKey+':pending';
  useEffect(()=>{
    try {setShop(shopSnapshot(JSON.parse(localStorage.getItem(storageKey)||'null')));}catch{}
    try {if(Number(sessionStorage.getItem(pendingKey))>Date.now())setPhase('login');}catch{}
    setReady(true);
    const update=()=>{setNow(Date.now());setOnline(navigator.onLine);};update();
    const timer=setInterval(update,1000);window.addEventListener('online',update);window.addEventListener('offline',update);
    return()=>{clearInterval(timer);window.removeEventListener('online',update);window.removeEventListener('offline',update);};
  },[storageKey,pendingKey]);
  function clearPending(){try{sessionStorage.removeItem(pendingKey);}catch{} setLogin('');setValue('');}
  async function start(){
    setPhase('starting');setError('');setNotice('');clearPending();
    try{
      const response=await fetch('/api/probe?action=start',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}',cache:'no-store'});
      if(response.status===401)throw Error('ログインの有効期限が切れました。ページを開き直してください。');
      const data=await response.json() as {url?:string;error?:string};
      if(!response.ok||!data.url)throw Error(data.error||'接続を開始できませんでした。');
      setLogin(data.url);setPhase('login');try{sessionStorage.setItem(pendingKey,String(Date.now()+600000));}catch{}
    }catch{setError('接続を開始できませんでした。通信状態を確認し、ページを開き直してください。');setPhase('idle');}
  }
  async function check(event:React.FormEvent){
    event.preventDefault();setPhase('checking');setError('');let url=value;setValue('');
    try{
      const request=fetch('/api/probe?action=check',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url}),cache:'no-store'});url='';
      const response=await request;
      if(response.status===401){setError('ログインの有効期限が切れました。ページを開き直してください。');return;}
      const data=await response.json() as {error?:string};
      const snapshot=shopSnapshot(data) as Snapshot|null;
      if(!response.ok||!snapshot){setError(data.error||'ショップを取得できませんでした。接続からやり直してください。');return;}
      setShop(snapshot);setNow(Date.now());
      try{localStorage.setItem(storageKey,JSON.stringify(snapshot));setNotice('ショップを更新しました。次回もこの端末で確認できます。');}
      catch{setNotice('ショップを取得しました。このブラウザーでは保存できないため、閉じると結果が消えます。');}
      resultHeading.current?.focus();
    }catch{setError('通信に失敗しました。接続からやり直してください。');}
    finally{url='';clearPending();setPhase('idle');}
  }
  function forget(){try{localStorage.removeItem(storageKey);}catch{setError('保存内容を消去できませんでした。ブラウザーのサイトデータ設定から削除してください。');return;}setShop(null);setNotice('この端末のショップを消去しました。');setError('');clearPending();setPhase('idle');}
  const busy=phase==='starting'||phase==='checking';
  const remaining=shop?.expiresAt?Math.max(0,Math.ceil((Date.parse(shop.expiresAt)-now)/1000)):null;
  const expired=remaining===0;
  const clock=remaining===null?'期限不明':[Math.floor(remaining/3600),Math.floor(remaining%3600/60),remaining%60].map(v=>String(v).padStart(2,'0')).join(' : ');
  return <>
    <a className="skip-link" href="#main">ショップへ移動</a>
    <header className="header"><a className="brand" href="/" aria-label="DAILY DROP ホーム"><svg width="32" height="32" viewBox="0 0 32 32" aria-hidden="true"><path d="M5 4h9l13 13v11h-9L5 15z" fill="currentColor"/><path d="m14 4 13 13h-9L5 4" fill="#111318"/></svg><span>DAILY<span className="brand-light">DROP</span><small>VALORANT SHOP VIEWER</small></span></a><a className="help-link" href="#help">使い方</a></header>
    <main id="main" className="page">
      <div className="page-heading"><div><p className="eyebrow">YOUR DAILY SELECTION</p><h1 ref={resultHeading} tabIndex={-1}>今日のショップ<span className="accent">.</span></h1></div>{shop&&<div className="countdown"><span>{expired?'更新時刻を過ぎています':'ショップ更新まで'}</span><strong>{clock}</strong><small>{shop.expiresAt?formatDate(shop.expiresAt)+' 更新予定':'再取得して確認してください'}</small></div>}</div>
      {!online&&<p className="notice" role="status">オフラインです。表示済みのショップは確認できます。新しい取得にはインターネット接続が必要です。</p>}
      <section className="shop-section" aria-labelledby="offers-title">
        <div className="toolbar"><h2 id="offers-title"><span className="marker"/>デイリーオファー <span className="muted">{shop?String(shop.items.length).padStart(2,'0'):'—'}</span></h2><span className="small">{shop?'最終取得 '+formatDate(shop.checkedAt):'PCの起動は不要'}</span></div>
        {expired&&<p className="notice">前回取得したショップです。商品が入れ替わっているため、Riotに再接続して更新してください。</p>}
        {shop&&!shop.expiresAt&&<p className="notice">更新期限を確認できませんでした。表示は最終取得時点の内容です。</p>}
        {shop?<div className={'offers'+(expired?' expired':'')}>{shop.items.map((item,i)=><article className="offer" key={item.id}><div className="offer-art"><span className="offer-number">0{i+1}</span>{item.image?<img src={item.image} alt="" referrerPolicy="no-referrer" onError={e=>{e.currentTarget.hidden=true;}}/>:<span className="muted">画像なし</span>}</div><div className="offer-info"><h3>{item.name}</h3><p className="price">{item.price.toLocaleString()} <span>VP</span></p></div></article>)}</div>:<div className="empty"><span className="empty-mark" aria-hidden="true">↗</span><h2>{ready?'あなたの4つのオファーを、ここに。':'ショップを読み込んでいます…'}</h2><p>Riotに接続すると、スキンの画像と価格が表示されます。<br/>取得したショップは、この端末に保存されます。</p></div>}
      </section>
      <section className="connection" aria-labelledby="connect-title"><div><p className="eyebrow">RIOT ACCOUNT</p><h2 id="connect-title">{shop?'ショップを更新する':'Riotに接続する'}</h2><p>公式ログイン後のURLを貼り付けるだけ。<br/>パスワードはRiotの画面で入力します。</p></div><div className="connection-actions">
        {phase==='idle'||phase==='starting'?<><button onClick={start} disabled={!ready||busy||!online}>{phase==='starting'?'準備しています…':shop?'Riotに再接続して更新':'Riotログインを準備'}</button><p className="small">毎回ログイン操作が必要です。</p></>:<>
          <ol className="steps"><li><strong>Riot公式ページでログイン</strong>{login?<a className="button" href={login} target="_blank" rel="noreferrer">Riot公式ログインを開く ↗</a>:<p>ログイン済みの場合は、下にURLを貼り付けてください。まだの場合は「やり直す」を押してください。</p>}</li><li><strong>認証後のURLをコピー</strong><p>404画面になっても、そのページのアドレス全体をコピー。この画面へ戻り、10分以内に貼り付けます。</p></li></ol>
          <form onSubmit={check}><label htmlFor="callback">認証後のURL</label><input id="callback" type="password" autoComplete="off" spellCheck={false} autoCapitalize="none" maxLength={40000} value={value} onChange={e=>setValue(e.target.value)} disabled={busy} placeholder="ここに貼り付け（内容は非表示）" aria-describedby="credential-note"/><p className="small" id="credential-note">認証URLは他の人に共有しないでください。</p><button type="submit" disabled={busy||!online||!value.trim()}>{phase==='checking'?'ショップを取得しています…':'ショップを取得'}</button><button className="quiet" type="button" disabled={busy} onClick={()=>{clearPending();setPhase('idle');setError('');}}>やり直す</button></form>
        </>}
        {error&&<p className="error" role="alert">{error}</p>}<p role="status" aria-live="polite" className="small">{notice}</p>
      </div></section>
      <section className="help" id="help"><h2>使い方と保存について</h2><details><summary>ホーム画面から開く</summary><p>Braveのまま使う場合は、このサイトをお気に入りに登録し、iPhoneのホーム画面にBraveウィジェットを追加してください。</p><p>独立したWebアプリとして追加する場合は、Safariでこのサイトを開き、共有メニューの「ホーム画面に追加」を選びます。「Webアプリとして開く」があればオンにしてください。追加後はホーム画面から開けます。</p><p>ブラウザーとホーム画面のアプリでは、ログインや保存内容が共有されない場合があります。追加したアプリ側でログインを始め、認証後はそのアプリに戻ってURLを貼り付けてください。</p><p><a href="https://support.brave.com/hc/en-us/articles/11089766712589" target="_blank" rel="noreferrer">Braveの公式案内 ↗</a> · <a href="https://support.apple.com/ja-jp/guide/iphone/iphea86e5236/ios" target="_blank" rel="noreferrer">Appleの公式案内 ↗</a></p></details><details><summary>保存されるもの・更新のしくみ</summary><p>商品名・画像URL・VP価格・取得時刻・更新期限だけをこの端末に保存します。Riotの認証情報は取得時に非公開サーバーからRiotへ送り、DB・ファイル・ログには保存しません。商品情報はValorant-APIから取得します。</p><p>自動ログイン・バックグラウンド更新・購入には対応していません。新しいショップを確認するときは再接続してください。アプリを開く際も通信が必要です。</p>{shop&&<button className="quiet" disabled={busy} onClick={forget}>保存したショップを消去</button>}</details></section>
    </main><footer>DAILY DROP <span>非公式のVALORANTショップビューアー。Riot Gamesとは提携していません。</span></footer>
  </>;
}
