import { app, BrowserWindow, session, shell } from 'electron';
import { randomBytes } from 'node:crypto';
import { createLocalServer } from './local-server.mjs';
import { authorizationRequest, parseAuthRedirect, createLoginController, LoginError } from './riot-login.mjs';

// A real, isolated Riot page handles passwords, MFA and CAPTCHA. No preload or DOM scraping.
function openLogin() {
  const auth = authorizationRequest();
  const partition = session.fromPartition(`riot-login-${randomBytes(16).toString('hex')}`, { cache: false });
  partition.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  partition.setPermissionCheckHandler(() => false);
  partition.on('will-download', event => event.preventDefault());
  const window = new BrowserWindow({ width: 520, height: 760, title: 'Riot Games — ログイン', autoHideMenuBar: true, webPreferences: { session: partition, nodeIntegration: false, contextIsolation: true, sandbox: true, devTools: false, webSecurity: true } });
  window.removeMenu();
  let finish, settled = false;
  const result = new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new LoginError('ログインの待ち時間が終了しました。もう一度お試しください。')), 10 * 60 * 1000);
    finish = (error, tokens) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!window.isDestroyed()) window.destroy();
      void partition.clearStorageData().catch(() => {});
      error ? reject(error) : resolve(tokens);
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
    }
  }
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => navigate(event, url));
  window.webContents.on('will-redirect', (event, url, _inPlace, mainFrame) => navigate(event, url, mainFrame));
  window.webContents.on('did-navigate', (event, url) => navigate(event, url));
  window.webContents.on('did-navigate-in-page', (event, url, mainFrame) => navigate(event, url, mainFrame));
  window.webContents.on('render-process-gone', () => finish(new LoginError('ログイン画面が終了しました。もう一度お試しください。')));
  window.on('closed', () => finish(new LoginError('ログインをキャンセルしました。')));
  void window.loadURL(auth.url).catch(() => { if (!settled) finish(new LoginError('Riotのログイン画面を読み込めません。ネットワークを確認してください。')); });
  return { result, cancel: () => finish(new LoginError('ログインをキャンセルしました。')) };
}

// Do not await ready at ESM top level: Electron waits for module evaluation before ready.
void app.whenReady().then(async () => {
// Keep the helper alive after closing the authentication popup; Ctrl+C ends it.
app.on('window-all-closed', () => {});
const auth = createLoginController({ openLogin });
const server = await createLocalServer({ auth });
const port = Number(process.env.PORT ?? 4173);
if (!Number.isInteger(port) || port < 1 || port > 65535) { console.error('PORTには1〜65535を指定してください。'); app.quit(); }
else {
  server.on('error', () => { console.error('起動できません。別のPORTを指定するか、起動中のDAILY DROPを終了してください。'); app.quit(); });
  server.listen(port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${port}`;
    console.log(`DAILY DROP: ${url}\n終了するには Ctrl+C を押してください。`);
    if (!process.argv.includes('--no-open')) void shell.openExternal(url).catch(() => console.log('上記URLをブラウザーで開いてください。'));
  });
}
app.on('before-quit', () => { auth.logout(); server.close(); });
process.on('SIGINT', () => app.quit());
process.on('SIGTERM', () => app.quit());
}).catch(() => { console.error('補助アプリを起動できませんでした。'); app.quit(); });
