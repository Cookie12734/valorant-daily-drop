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
      for (const path of ['/api/login', '/api/logout', '/api/shop', '/api/night-market', '/api/purchase/quote', '/api/purchase/confirm', '/api/purchase/status']) {
        assert.equal((await fetch(origin + path, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
      }
      const status = await window.webContents.executeJavaScript(`fetch('/api/status').then(r => r.json())`);
      assert.deepEqual(status, { local: true, login: true, purchase: true, auth: { state: 'signed_out' } });
      assert.equal(new URL(window.webContents.getURL()).hash, '');
      assert.equal(await window.webContents.executeJavaScript(`sessionStorage.length`), 0);
      const page = await (await fetch(origin)).text();
      assert.match(page, /DailyDrop\.exe/);
      assert.equal(BrowserWindow.getAllWindows().length, 1);
      assert.deepEqual(window.getContentSize(), [420, 460]);
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
        let purchaseResult = 'idle', confirmations = 0, loseResponse = false;
        const offers = Array.from({length:6}, (_, i) => ({id:'00000000-0000-0000-0000-' + String(i + 1).padStart(12,'0'), price:1000, originalPrice:2000, discountPercent:50}));
        const base = {schemaVersion:1,source:'riot-login',region:'ap',fetchedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+3600000).toISOString()};
        window.fetch = async (url, options) => {
          if (String(url).startsWith('https://valorant-api.com/')) return Response.json({data:{displayName:'テスト ヴァンダル',displayIcon:'https://media.valorant-api.com/test.png'}});
          if (url === '/api/login') return Response.json({local:true,login:true,purchase:true,auth:{state:'signed_in'}});
          if (url === '/api/shop') return Response.json({...base,offers:offers.slice(0,4)});
          if (url === '/api/night-market') return Response.json({...base,kind:'night-market',active,expiresAt:active?base.expiresAt:null,offers:active?offers:[]});
          if (url === '/api/purchase/status') return Response.json({state:purchaseResult});
          if (url === '/api/purchase/quote') { const input=JSON.parse(options.body); return Response.json({quoteId:crypto.randomUUID(),skinId:input.skinId,price:input.expectedPrice,balance:5000,expiresAt:new Date(Date.now()+60000).toISOString()}); }
          if (url === '/api/purchase/confirm') { confirmations++; purchaseResult=loseResponse?'unknown':'pending'; if(loseResponse) throw new TypeError('test lost response'); return Response.json({state:purchaseResult}); }
          return originalFetch(url, options);
        };
        const wait = async predicate => { for(let i=0;i<100;i++){ if(predicate()) return; await new Promise(r=>setTimeout(r,20)); } throw Error('UI transition timed out'); };
        try {
          document.querySelector('#night-button').click();
          const selected = document.querySelector('#night-button').getAttribute('aria-pressed') === 'true';
          document.querySelector('#load-button').click();
          await wait(()=>document.querySelectorAll('.skin-card').length===6 && !document.querySelector('#load-button').disabled);
          const discounted = document.querySelectorAll('.discount').length===6;
          const sixFits = [...document.querySelectorAll('.skin-card')].every(e => { const r=e.getBoundingClientRect(); return r.right<=innerWidth && r.bottom<=innerHeight; });
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
          return {selected,discounted,daily,inactive,sixFits,quoteShowsPrice,dialogFits,cancelledWithoutCharge,singleSend,completed,noRetry};
        } finally { window.fetch=originalFetch; }
      })()`);
      assert.deepEqual(switching, { selected: true, discounted: true, daily: true, inactive: true, sixFits: true, quoteShowsPrice: true, dialogFits: true, cancelledWithoutCharge: true, singleSend: true, completed: true, noRetry: true });
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
        window.showInactive();
        await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
        writeFileSync(process.env.DAILY_DROP_SMOKE_IMAGE, (await window.webContents.capturePage()).toPNG());
      }
      passed = true;
      console.log('PASS: compact layout, shop/night switching, purchase confirmation/cancel/results/no-retry, isolated session and protected local API');
      window.close();
    } catch (error) { console.error(error); app.exit(1); }
  });
});
// No top-level await: Electron must finish module evaluation before emitting ready.
const entry = process.env.DAILY_DROP_SMOKE_ENTRY ? pathToFileURL(process.env.DAILY_DROP_SMOKE_ENTRY).href : './desktop.mjs';
void import(entry).catch(error => { console.error(error); app.exit(1); });
