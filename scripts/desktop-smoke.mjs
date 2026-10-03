// Run with: npx electron scripts/desktop-smoke.mjs
// Isolated profile: never touches a user's Riot session or opens a login page.
import { app, BrowserWindow } from 'electron';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
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
      passed = true;
      console.log('PASS: desktop window, bundled UI, isolated session, loopback API and secure renderer');
      window.close();
    } catch (error) { console.error(error); app.exit(1); }
  });
});
// No top-level await: Electron must finish module evaluation before emitting ready.
const entry = process.env.DAILY_DROP_SMOKE_ENTRY ? pathToFileURL(process.env.DAILY_DROP_SMOKE_ENTRY).href : './desktop.mjs';
void import(entry).catch(error => { console.error(error); app.exit(1); });
