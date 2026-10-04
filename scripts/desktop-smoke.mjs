// Run with: npx electron scripts/desktop-smoke.mjs
// Isolated profile: never touches a user's Riot session or opens a login page.
import { app, BrowserWindow } from 'electron';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

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
      assert.match(window.webContents.getTitle(), /DAILY DROP/);
      const preferences = window.webContents.getLastWebPreferences();
      assert.equal(preferences.nodeIntegration, false);
      assert.equal(preferences.contextIsolation, true);
      assert.equal(preferences.sandbox, true);
      const status = await (await fetch(`${origin}/api/status`)).json();
      assert.deepEqual(status, { local: true, login: true, auth: { state: 'signed_out' } });
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
      if (process.env.DAILY_DROP_SMOKE_IMAGE) writeFileSync(process.env.DAILY_DROP_SMOKE_IMAGE, (await window.webContents.capturePage()).toPNG());
      passed = true;
      console.log('PASS: compact 420x460 window, 4 cards fit in 2 columns, preview hidden, always-on-top, isolated session and secure renderer');
      window.close();
    } catch (error) { console.error(error); app.exit(1); }
  });
});
// No top-level await: Electron must finish module evaluation before emitting ready.
const entry = process.env.DAILY_DROP_SMOKE_ENTRY ? pathToFileURL(process.env.DAILY_DROP_SMOKE_ENTRY).href : './desktop.mjs';
void import(entry).catch(error => { console.error(error); app.exit(1); });
