// Run with: npx electron scripts/desktop-smoke.mjs
// Isolated profile: never touches a user's Riot session or opens a login page.
import { app, BrowserWindow } from 'electron';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createLocalServer } from './local-server.mjs';

app.setPath('appData', mkdtempSync(join(tmpdir(), 'daily-drop-smoke-')));
process.env.PORT = '0';
process.argv.push('--no-open');
let passed = false;
const timer = setTimeout(() => { console.error('Desktop startup timed out'); app.exit(1); }, 30000);
app.on('will-quit', () => { clearTimeout(timer); if (!passed) process.exitCode = 1; });
app.once('browser-window-created', (_event, window) => {
  window.webContents.once('did-finish-load', async () => {
    try {
      const origin = new URL(window.webContents.getURL()).origin;
      assert.equal(new URL(origin).hostname, '127.0.0.1');
      assert.equal(window.webContents.getTitle(), 'DAILY DROP');
      const preferences = window.webContents.getLastWebPreferences();
      assert.equal(preferences.nodeIntegration, false);
      assert.equal(preferences.contextIsolation, true);
      assert.equal(preferences.sandbox, true);
      assert.equal((await fetch(`${origin}/api/status`)).status, 403, 'native callers cannot read status');
      for (const path of ['/api/login', '/api/logout', '/api/shop', '/api/night-market', '/api/accessory', '/api/wallet', '/api/purchase/quote', '/api/purchase/confirm', '/api/purchase/status', '/api/topup/start', '/api/topup/status']) {
        assert.equal((await fetch(origin + path, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
      }
      const status = await window.webContents.executeJavaScript(`fetch('/api/status').then(r => r.json())`);
      assert.deepEqual(status, { local: true, login: true, purchase: true, topup: true, auth: { state: 'signed_out' } });
      assert.equal(new URL(window.webContents.getURL()).hash, '');
      assert.equal(await window.webContents.executeJavaScript(`sessionStorage.length`), 0);
      const page = await (await fetch(origin)).text();
      assert.match(page, /DailyDrop\.exe/);
      assert.equal(BrowserWindow.getAllWindows().length, 1);
      const [contentWidth, contentHeight] = window.getContentSize();
      assert.ok(Math.abs(contentWidth - 420) <= 2 && Math.abs(contentHeight - 460) <= 2, 'compact size allows Windows DPI rounding');
      assert.equal(window.isAlwaysOnTop(), true);
      // Exercise the compact presentation with built-in sample cards, never a real account.
      const layout = await window.webContents.executeJavaScript(`(async () => {
        for (let i = 0; i < 100 && getComputedStyle(document.querySelector('.header')).display !== 'none'; i++) await new Promise(r => setTimeout(r, 10));
        const hidden = getComputedStyle(document.querySelector('#shop-grid')).display === 'none';
        document.querySelector('#preview-button').hidden = false;
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        const cards = [...document.querySelectorAll('.skin-card')].map(x => x.getBoundingClientRect());
        return { hidden, headerHidden: getComputedStyle(document.querySelector('.header')).display === 'none', count: cards.length, twoColumns: cards[0].y === cards[1].y && cards[2].y > cards[0].y, fits: cards.every(r => r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight) };
      })()`);
      assert.deepEqual(layout, { hidden: true, headerHidden: true, count: 4, twoColumns: true, fits: true });
      const switching = await window.webContents.executeJavaScript(`(async () => {
        const originalFetch = window.fetch;
        let active = true;
        let walletMode = 'success', vp = 1200, releaseWallet, insufficient = false, topupStarts = 0;
        let purchaseResult = 'idle', confirmations = 0, loseResponse = false;
        const offers = Array.from({length:6}, (_, i) => ({id:'00000000-0000-0000-0000-' + String(i + 1).padStart(12,'0'), price:1000, originalPrice:2000, discountPercent:50}));
        const base = {schemaVersion:1,source:'riot-login',region:'ap',fetchedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+3600000).toISOString()};
        window.fetch = async (url, options) => {
          if (String(url).startsWith('https://valorant-api.com/')) return Response.json({data:{displayName:'テスト ヴァンダル',displayIcon:'https://media.valorant-api.com/test.png'}});
          if (url === '/api/login') return Response.json({local:true,login:true,purchase:true,topup:true,auth:{state:'signed_in'}});
          if (url === '/api/logout') return Response.json({local:true,login:true,purchase:true,topup:true,auth:{state:'signed_out'}});
          if (url === '/api/wallet') {
            if (walletMode === 'hold') return new Promise(resolve => { releaseWallet=()=>resolve(Response.json({VP:9999,RP:9999,KC:9999})); });
            if (walletMode === 'error') throw new TypeError('test offline');
            return Response.json(walletMode === 'invalid' ? {VP:vp,KC:10000} : {VP:vp,RP:0,KC:10000});
          }
          if (url === '/api/shop') return Response.json({...base,offers:offers.slice(0,4)});
          if (url === '/api/night-market') return Response.json({...base,kind:'night-market',active,expiresAt:active?base.expiresAt:null,offers:active?offers:[]});
          if (url === '/api/accessory') return Response.json({...base,kind:'accessory',offers:offers.slice(0,4).map((o,i)=>({id:o.id,offerId:o.id,price:4000,itemTypeId:['dd3bf334-87f3-40bd-b043-682a57a8dc3a','d5f120f8-ff8c-4aac-92ea-f2b5acbe9475','3f296c07-64c3-494c-923b-fe692a4fa1bd','de7caa6b-adf7-4588-bbd1-143831e786c6'][i]}))});
          if (url === '/api/topup/start') { topupStarts++; return Response.json({state:'open'}); }
          if (url === '/api/topup/status') { vp=2300; insufficient=false; return Response.json({state:'closed'}); }
          if (url === '/api/purchase/status') return Response.json({state:purchaseResult});
          if (url === '/api/purchase/quote') { const input=JSON.parse(options.body); if(insufficient) return Response.json({error:'VPが不足しています。',code:'INSUFFICIENT_VP'},{status:409}); return Response.json({quoteId:crypto.randomUUID(),skinId:input.skinId,currency:input.mode==='accessory'?'KC':'VP',price:input.expectedPrice,balance:5000,expiresAt:new Date(Date.now()+60000).toISOString()}); }
          if (url === '/api/purchase/confirm') { confirmations++; purchaseResult=loseResponse?'unknown':'pending'; if(loseResponse) throw new TypeError('test lost response'); return Response.json({state:purchaseResult}); }
          return originalFetch(url, options);
        };
        const wait = async predicate => { for(let i=0;i<100;i++){ if(predicate()) return; await new Promise(r=>setTimeout(r,20)); } throw Error('UI transition timed out'); };
        try {
          document.querySelector('#night-button').click();
          const selected = document.querySelector('#night-button').getAttribute('aria-pressed') === 'true';
          document.querySelector('#load-button').click();
          await wait(()=>document.querySelectorAll('.skin-card').length===6 && !document.querySelector('#load-button').disabled);
          document.querySelector('#wallet-button').click();
          await wait(()=>!document.querySelector('#wallet-refresh-button').disabled);
          const walletShowsBalances=document.querySelector('#wallet-VP').textContent==='1,200 VP' && document.querySelector('#wallet-RP').textContent==='0 RP' && document.querySelector('#wallet-KC').textContent==='10,000 KC' && document.querySelector('#wallet-balances').textContent.includes('レディアナイトポイント');
          const walletRect=document.querySelector('#wallet-dialog').getBoundingClientRect();
          const walletFits=walletRect.left>=0 && walletRect.right<=innerWidth && walletRect.bottom<=innerHeight;
          vp=1300; document.querySelector('#wallet-refresh-button').click();
          await wait(()=>!document.querySelector('#wallet-refresh-button').disabled);
          const walletRefreshes=document.querySelector('#wallet-VP').textContent==='1,300 VP';
          document.querySelector('#wallet-topup-button').click();
          const topupRect=document.querySelector('#topup-dialog').getBoundingClientRect();
          const topupFits=topupRect.left>=0 && topupRect.right<=innerWidth && topupRect.bottom<=innerHeight;
          document.querySelector('#topup-open-button').click();
          document.querySelector('#topup-open-button').click();
          await wait(()=>!document.querySelector('#topup-dialog').open && document.querySelector('#wallet-VP').textContent==='2,300 VP');
          const topupWallet=topupStarts===1 && confirmations===0;
          walletMode='error'; document.querySelector('#wallet-refresh-button').click();
          await wait(()=>!document.querySelector('#wallet-refresh-button').disabled);
          const walletError=document.querySelector('#wallet-balances').hidden && document.querySelector('#wallet-VP').textContent==='—' && document.querySelector('#wallet-message').textContent.includes('取得できません');
          walletMode='invalid'; document.querySelector('#wallet-refresh-button').click();
          await wait(()=>!document.querySelector('#wallet-refresh-button').disabled);
          const walletInvalid=document.querySelector('#wallet-balances').hidden && document.querySelector('#wallet-message').textContent.includes('読み取れません');
          walletMode='success'; document.querySelector('#wallet-refresh-button').click();
          await wait(()=>!document.querySelector('#wallet-balances').hidden);
          document.querySelector('#wallet-close-button').click();
          const discounted = document.querySelectorAll('.discount').length===6;
          const sixFits = [...document.querySelectorAll('.skin-card')].every(e => { const r=e.getBoundingClientRect(); return r.right<=innerWidth && r.bottom<=innerHeight; });
          document.querySelector('#accessory-button').click();
          await wait(()=>document.querySelectorAll('.skin-card').length===4 && !document.querySelector('#load-button').disabled);
          const accessory=document.querySelector('#view-title').textContent==='アクセサリーストア' && document.querySelector('#night-button').getAttribute('aria-pressed')==='false' && [...document.querySelectorAll('.price-unit')].every(e=>e.textContent==='KC');
          const accessoryFits=[...document.querySelectorAll('.skin-card'), document.querySelector('#accessory-button')].every(e=>{const r=e.getBoundingClientRect();return r.right<=innerWidth && r.bottom<=innerHeight;});
          document.querySelector('.skin-card').click();
          document.querySelector('#skin-purchase-button').click();
          await wait(()=>document.querySelector('#purchase-confirm-button').disabled===false);
          const accessoryQuote=document.querySelector('#purchase-price').textContent==='4,000 KC' && document.querySelector('#purchase-after-balance').textContent==='1,000 KC';
          document.querySelector('#purchase-confirm-button').click();
          await wait(()=>document.querySelector('#purchase-dialog').dataset.state==='pending' && !document.querySelector('#purchase-check-button').disabled);
          purchaseResult='complete';
          document.querySelector('#purchase-check-button').click();
          await wait(()=>document.querySelector('#purchase-dialog').dataset.state==='complete' && !document.querySelector('#load-button').disabled);
          const accessoryPurchased=confirmations===1;
          document.querySelector('#purchase-cancel-button').click();
          confirmations=0; purchaseResult='idle';
          document.querySelector('#daily-button').click();
          await wait(()=>document.querySelectorAll('.skin-card').length===4 && !document.querySelector('#load-button').disabled);
          const daily = document.querySelector('#view-title').textContent==='今日のショップ';
          active=false;
          document.querySelector('#night-button').click();
          await wait(()=>document.querySelector('#clock').textContent==='開催なし');
          const inactive=document.querySelector('#shop-grid').textContent.includes('開催されていません') && !document.querySelectorAll('.skin-card').length;
          document.querySelector('#daily-button').click();
          await wait(()=>document.querySelectorAll('.skin-card').length===4 && !document.querySelector('#load-button').disabled);
          document.querySelector('.skin-card').click();
          document.querySelector('#skin-purchase-button').click();
          await wait(()=>document.querySelector('#purchase-confirm-button').disabled===false);
          document.querySelector('#purchase-cancel-button').click();
          insufficient=true;
          document.querySelector('.skin-card').click();
          document.querySelector('#skin-purchase-button').click();
          await wait(()=>!document.querySelector('#purchase-topup-button').hidden && !document.querySelector('#purchase-topup-button').disabled);
          const insufficientBlocked=document.querySelector('#purchase-confirm-button').disabled;
          document.querySelector('#purchase-topup-button').click();
          document.querySelector('#topup-open-button').click();
          await wait(()=>!document.querySelector('#topup-dialog').open && !document.querySelector('#purchase-confirm-button').disabled);
          const topupPurchase=topupStarts===2 && confirmations===0 && document.querySelector('#purchase-topup-button').hidden;
          const quoteShowsPrice=document.querySelector('#purchase-price').textContent==='1,000 VP' && document.querySelector('#purchase-after-balance').textContent==='4,000 VP';
          const dialogRect=document.querySelector('#purchase-dialog').getBoundingClientRect();
          const dialogFits=dialogRect.left>=0 && dialogRect.right<=innerWidth && dialogRect.bottom<=innerHeight;
          document.querySelector('#purchase-cancel-button').click();
          const cancelledWithoutCharge=confirmations===0 && !document.querySelector('#purchase-dialog').open;
          document.querySelector('.skin-card').click();
          document.querySelector('#skin-purchase-button').click();
          await wait(()=>document.querySelector('#purchase-confirm-button').disabled===false);
          document.querySelector('#purchase-confirm-button').click();
          document.querySelector('#purchase-confirm-button').click();
          await wait(()=>!document.querySelector('#purchase-check-button').hidden && !document.querySelector('#purchase-check-button').disabled);
          const singleSend=confirmations===1;
          purchaseResult='complete';
          document.querySelector('#purchase-check-button').click();
          await wait(()=>document.querySelector('#purchase-dialog').dataset.state==='complete' && !document.querySelector('#load-button').disabled);
          const completed=!document.querySelector('#purchase-result').hidden;
          document.querySelector('#purchase-cancel-button').click();
          loseResponse=true;
          document.querySelectorAll('.skin-card')[1].click();
          document.querySelector('#skin-purchase-button').click();
          await wait(()=>document.querySelector('#purchase-confirm-button').disabled===false);
          document.querySelector('#purchase-confirm-button').click();
          await wait(()=>document.querySelector('#purchase-dialog').dataset.state==='unknown' && !document.querySelector('#purchase-check-button').disabled);
          document.querySelector('#purchase-confirm-button').click();
          document.querySelector('#purchase-check-button').click();
          await wait(()=>!document.querySelector('#purchase-check-button').disabled);
          const noRetry=confirmations===2 && document.querySelector('#purchase-dialog').dataset.state==='unknown';
          document.querySelector('#purchase-cancel-button').click();
          walletMode='hold'; document.querySelector('#wallet-button').click();
          await wait(()=>!!releaseWallet);
          document.querySelector('#wallet-close-button').click();
          document.querySelector('#logout-button').click();
          await wait(()=>document.querySelector('#logout-button').hidden);
          releaseWallet();
          await new Promise(r=>setTimeout(r,30));
          const walletLogout=document.querySelector('#wallet-button').hidden && !document.querySelector('#wallet-dialog').open && document.querySelector('#wallet-balances').hidden && document.querySelector('#wallet-VP').textContent==='—';
          return {topupFits,topupWallet,insufficientBlocked,topupPurchase,walletShowsBalances,walletFits,walletRefreshes,walletError,walletInvalid,walletLogout,accessory,accessoryFits,accessoryQuote,accessoryPurchased,selected,discounted,daily,inactive,sixFits,quoteShowsPrice,dialogFits,cancelledWithoutCharge,singleSend,completed,noRetry};
        } finally { window.fetch=originalFetch; }
      })()`);
      assert.deepEqual(switching, { topupFits: true, topupWallet: true, insufficientBlocked: true, topupPurchase: true, walletShowsBalances: true, walletFits: true, walletRefreshes: true, walletError: true, walletInvalid: true, walletLogout: true, accessory: true, accessoryFits: true, accessoryQuote: true, accessoryPurchased: true, selected: true, discounted: true, daily: true, inactive: true, sixFits: true, quoteShowsPrice: true, dialogFits: true, cancelledWithoutCharge: true, singleSend: true, completed: true, noRetry: true });
      const updates = await window.webContents.executeJavaScript(`(async () => {
        const originalFetch = window.fetch;
        let installs = 0;
        const state = { currentVersion: '1.4.0-preview.2', supported: true, phase: 'idle', release: { version: '1.4.0-preview.3', name: '更新機能の改善', notes: '更新内容\\n・最新リリースをアプリから取得\\n・ログイン情報を保持\\n<script>window.injected = true</script>' } };
        const wait = async predicate => { for(let i=0;i<100;i++){ if(predicate()) return; await new Promise(r=>setTimeout(r,20)); } throw new Error('Update UI timed out'); };
        window.fetch = async (url, options) => {
          if (!String(url).startsWith('/api/update/')) return originalFetch(url, options);
          if (String(url).endsWith('/install')) { installs++; state.phase = 'downloading'; }
          return new Response(JSON.stringify(state), { headers: {'Content-Type':'application/json'} });
        };
        try {
          document.querySelector('#update-check').click();
          await wait(()=>!document.querySelector('#update-button').hidden);
          document.querySelector('#update-button').click();
          await wait(()=>!document.querySelector('#update-check').disabled);
          const rect = document.querySelector('#update-dialog').getBoundingClientRect();
          const fits = rect.left>=0 && rect.right<=innerWidth && rect.bottom<=innerHeight;
          const safeNotes = !window.injected && document.querySelector('#update-notes').textContent.includes('<script>');
          document.querySelector('#update-install').click();
          document.querySelector('#update-install').click();
          await wait(()=>document.querySelector('#update-message').textContent.includes('ダウンロード'));
          const busy = document.querySelector('#update-install').disabled && installs===1;
          state.phase='error'; state.error='接続できません。再試行してください。';
          await wait(()=>document.querySelector('#update-message').textContent===state.error);
          const retry = !document.querySelector('#update-install').disabled;
          document.querySelector('#update-dialog').close();
          return { fits, safeNotes, busy, retry };
        } finally { window.fetch=originalFetch; }
      })()`);
      assert.deepEqual(updates, { fits: true, safeNotes: true, busy: true, retry: true });
      // Another renderer, even in the same Electron session, gets no capability.
      const otherWindow = new BrowserWindow({ show: false, webPreferences: { session: window.webContents.session, sandbox: true, contextIsolation: true, nodeIntegration: false } });
      try {
        await otherWindow.loadURL(origin);
        assert.equal(await otherWindow.webContents.executeJavaScript(`fetch('/api/status').then(r => r.status)`), 403);
      } finally { otherWindow.destroy(); }
      // Browser helper: launch fragment, removal from address bar, reload and real POST.
      let browserCalls = 0;
      const helper = await createLocalServer({ loadShop: async () => { browserCalls++; return { schemaVersion: 1, source: 'riot-client', region: 'ap', fetchedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString(), offers: [] }; } });
      await new Promise(resolve => helper.listen(0, '127.0.0.1', resolve));
      const helperURL = `http://127.0.0.1:${helper.address().port}`;
      const browser = new BrowserWindow({ show: false, webPreferences: { partition: 'browser-helper-test', sandbox: true, contextIsolation: true, nodeIntegration: false } });
      try {
        await browser.loadURL(`${helperURL}/#local-api=${helper.apiToken}`);
        assert.equal(new URL(browser.webContents.getURL()).hash, '');
        await browser.loadURL(helperURL);
        assert.equal(await browser.webContents.executeJavaScript(`(async () => {
          for (let i=0;i<100;i++) { if (document.querySelector('#load-label').textContent==='ショップを取得') return true; await new Promise(r=>setTimeout(r,20)); } return false;
        })()`), true);
        await browser.webContents.executeJavaScript(`document.querySelector('#load-button').click()`);
        for (let i = 0; i < 100 && !browserCalls; i++) await new Promise(resolve => setTimeout(resolve, 20));
        assert.equal(browserCalls, 1);
      } finally { browser.destroy(); await new Promise(resolve => helper.close(resolve)); }
      if (process.env.DAILY_DROP_SMOKE_IMAGE) {
        if (process.env.DAILY_DROP_SMOKE_UPDATE_IMAGE) await window.webContents.executeJavaScript("document.querySelector('#update-dialog').showModal()");
        window.showInactive();
        await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
        writeFileSync(process.env.DAILY_DROP_SMOKE_IMAGE, (await window.webContents.capturePage()).toPNG());
      }
      passed = true;
      console.log('PASS: update dialog/notes/progress/retry, compact layout, wallet, shop, purchase, isolated session and protected local API');
      window.close();
    } catch (error) { console.error(error); app.exit(1); }
  });
});
// No top-level await: Electron must finish module evaluation before emitting ready.
const entry = process.env.DAILY_DROP_SMOKE_ENTRY ? pathToFileURL(process.env.DAILY_DROP_SMOKE_ENTRY).href : './desktop.mjs';
void import(entry).catch(error => { console.error(error); app.exit(1); });
