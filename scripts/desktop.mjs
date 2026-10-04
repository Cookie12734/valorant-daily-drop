import { app, BrowserWindow, session, shell, dialog, Menu } from 'electron';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLocalServer } from './local-server.mjs';
import { authorizationRequest, parseAuthRedirect, createLoginController, LoginError } from './riot-login.mjs';

app.setName('DAILY DROP');

// A real, isolated Riot page handles passwords, MFA and CAPTCHA. No preload or DOM scraping.
function openLogin(partition, parent) {
  const auth = authorizationRequest();
  const window = new BrowserWindow({ parent, modal: true, show: false, width: 520, height: 760, title: 'Riot Games — ログイン', autoHideMenuBar: true, webPreferences: { session: partition, nodeIntegration: false, contextIsolation: true, sandbox: true, devTools: false, webSecurity: true } });
  window.removeMenu();
  let finish, settled = false;
  const result = new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new LoginError('ログインの待ち時間が終了しました。もう一度お試しください。')), 10 * 60 * 1000);
    finish = (error, tokens) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!window.isDestroyed()) window.destroy();
      if (error) reject(error);
      else partition.cookies.flushStore().then(() => resolve(tokens), () => reject(new LoginError('ログイン状態を保存できませんでした。PCの保存領域を確認してください。')));
    };
  });
  function navigate(event, legacyURL, legacyMainFrame) {
    if (event.isMainFrame === false || legacyMainFrame === false || settled) return;
    const raw = event.url ?? legacyURL;
    let url;
    try { url = new URL(raw); } catch { event.preventDefault?.(); return; }
    try {
      const tokens = parseAuthRedirect(raw, auth.state);
      if (tokens) { event.preventDefault?.(); finish(null, tokens); return; }
    } catch (error) { event.preventDefault?.(); finish(error); return; }
    if (url.protocol !== 'https:' || url.username || url.password || !['auth.riotgames.com', 'authenticate.riotgames.com', 'login.riotgames.com', 'playvalorant.com'].includes(url.hostname)) {
      event.preventDefault?.();
      finish(new LoginError('このログイン画面ではRiotのユーザー名とパスワードを使用してください。外部サービス経由のログインには対応していません。'));
      return;
    }
    if (url.hostname === 'authenticate.riotgames.com' || url.hostname === 'login.riotgames.com') window.show();
  }
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => navigate(event, url));
  window.webContents.on('will-redirect', (event, url, _inPlace, mainFrame) => navigate(event, url, mainFrame));
  window.webContents.on('did-navigate', (event, url) => navigate(event, url));
  window.webContents.on('did-navigate-in-page', (event, url, mainFrame) => navigate(event, url, mainFrame));
  window.webContents.on('did-finish-load', () => { if (!settled) window.show(); });
  window.webContents.on('render-process-gone', () => finish(new LoginError('ログイン画面が終了しました。もう一度お試しください。')));
  window.on('closed', () => finish(new LoginError('ログインをキャンセルしました。')));
  void window.loadURL(auth.url).catch(() => { if (!settled) finish(new LoginError('Riotのログイン画面を読み込めません。ネットワークを確認してください。')); });
  return { result, cancel: () => finish(new LoginError('ログインをキャンセルしました。')) };
}

// Do not await ready at ESM top level: Electron waits for module evaluation before ready.
const profile = join(app.getPath('appData'), 'DailyDrop');
mkdirSync(profile, { recursive: true });
app.setPath('userData', profile);
if (!app.requestSingleInstanceLock()) app.quit();
else {
let mainWindow;
app.on('second-instance', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});
void app.whenReady().then(async () => {
app.on('window-all-closed', () => app.quit());
const partition = session.fromPartition('persist:riot-login', { cache: false });
partition.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
partition.setPermissionCheckHandler(() => false);
partition.on('will-download', event => event.preventDefault());
const auth = createLoginController({ openLogin: () => openLogin(partition, mainWindow), clearSavedLogin: async () => {
  await partition.clearStorageData();
  await partition.cookies.flushStore();
} });
const server = await createLocalServer({ auth });
// An ephemeral loopback port serves bundled files inside this app; no hosted backend.
const port = Number(process.env.PORT ?? 0);
if (!Number.isInteger(port) || port < 0 || port > 65535) { dialog.showErrorBox('DAILY DROP', 'PORTには0〜65535を指定してください。'); app.quit(); }
else {
  server.on('error', () => { dialog.showErrorBox('DAILY DROP', 'アプリを起動できません。起動中のDAILY DROPを終了して再度お試しください。'); app.quit(); });
  server.listen(port, '127.0.0.1', async () => {
    const url = `http://127.0.0.1:${server.address().port}`;
    const uiSession = session.fromPartition('daily-drop-ui');
    mainWindow = new BrowserWindow({ show: false, width: 420, height: 460, useContentSize: true, minWidth: 360, minHeight: 400, alwaysOnTop: true, maximizable: false, title: 'DAILY DROP', backgroundColor: '#111318', autoHideMenuBar: true, webPreferences: { session: uiSession, nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, devTools: !app.isPackaged } });
    // Main-process capability: never exposed to renderer JS, URLs or persistent storage.
    uiSession.webRequest.onBeforeSendHeaders({ urls: [`${url}/api/*`] }, (details, callback) => {
      if (mainWindow && !mainWindow.isDestroyed() && details.webContentsId === mainWindow.webContents.id && details.resourceType === 'xhr') {
        details.requestHeaders['X-Daily-Drop-Token'] = server.apiToken;
      }
      callback({ requestHeaders: details.requestHeaders });
    });
    mainWindow.removeMenu();
    // Desktop-only presentation. The shared web files remain byte-for-byte unchanged.
    const compactCSS = readFileSync(new URL('./compact.css', import.meta.url), 'utf8');
    mainWindow.webContents.on('context-menu', () => Menu.buildFromTemplate([
      { label: '常に手前に表示', type: 'checkbox', checked: mainWindow.isAlwaysOnTop(), click: item => mainWindow.setAlwaysOnTop(item.checked) },
      { role: 'minimize', label: '最小化' },
      { role: 'close', label: '閉じる' },
    ]).popup({ window: mainWindow }));
    mainWindow.webContents.on('did-finish-load', () => {
      void mainWindow.webContents.insertCSS(compactCSS).then(() => {
        if (mainWindow && !mainWindow.isDestroyed() && !process.argv.includes('--no-open')) mainWindow.show();
      }).catch(() => {});
    });
    mainWindow.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    mainWindow.webContents.session.setPermissionCheckHandler(() => false);
    const external = raw => {
      try {
        const target = new URL(raw);
        if (target.protocol === 'https:' && !target.username && !target.password && ['github.com', 'valorant-api.com'].includes(target.hostname)) void shell.openExternal(target.href).catch(() => {});
      } catch { /* Unrecognized navigation stays blocked. */ }
    };
    mainWindow.webContents.setWindowOpenHandler(({ url: target }) => { external(target); return { action: 'deny' }; });
    mainWindow.webContents.on('will-navigate', (event, target) => {
      if (new URL(target).origin !== url) { event.preventDefault(); external(target); }
    });
    mainWindow.on('closed', () => { mainWindow = undefined; app.quit(); });
    try {
      if ((await partition.cookies.get({ url: 'https://auth.riotgames.com', name: 'ssid' })).length) auth.start();
    } catch { /* Manual login remains available if the stored session cannot be read. */ }
    console.log(`DAILY DROP: ${url}\nショップ画面を閉じると終了します。`);
    try {
      await mainWindow.loadURL(url);
    } catch { dialog.showErrorBox('DAILY DROP', 'ショップ画面を開けませんでした。アプリを再起動してください。'); app.quit(); }
  });
}
app.on('before-quit', () => { auth.dispose(); server.close(); });
process.on('SIGINT', () => app.quit());
process.on('SIGTERM', () => app.quit());
}).catch(() => { dialog.showErrorBox('DAILY DROP', 'アプリを起動できませんでした。'); app.quit(); });
}
