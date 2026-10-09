import { BrowserWindow, session } from 'electron';
import { randomUUID } from 'node:crypto';
import { paymentURL } from './topup.mjs';

export function allowedPaymentNavigation(raw) {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && !u.username && !u.password && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(u.hostname) && !/(?:^|\.)(?:localhost|local|internal)$/i.test(u.hostname);
  } catch { return false; }
}

export function openPaymentWindow(raw, parent) {
  const url = paymentURL(raw);
  const isolated = session.fromPartition(`vp-payment-${randomUUID()}`, { cache: false });
  isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  isolated.setPermissionCheckHandler(() => false);
  isolated.on('will-download', event => event.preventDefault());
  const children = new Set();
  const webPreferences = { session: isolated, nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, devTools: false };
  const window = new BrowserWindow({ parent, modal: true, width: 1100, height: 820, minWidth: 720, minHeight: 600, title: 'Riot Games — VP購入', autoHideMenuBar: true, webPreferences });
  function secure(target) {
    target.removeMenu();
    target.webContents.on('will-navigate', (event, destination) => { if (!allowedPaymentNavigation(destination)) event.preventDefault(); });
    target.webContents.on('will-redirect', (event, destination) => { if (!allowedPaymentNavigation(destination)) event.preventDefault(); });
    target.webContents.on('will-attach-webview', event => event.preventDefault());
    target.webContents.setWindowOpenHandler(({ url: destination }) => allowedPaymentNavigation(destination) ? { action: 'allow', overrideBrowserWindowOptions: { parent: window, autoHideMenuBar: true, webPreferences } } : { action: 'deny' });
    target.webContents.on('did-create-window', child => { children.add(child); secure(child); child.on('closed', () => children.delete(child)); });
  }
  secure(window);
  const closed = new Promise(resolve => window.on('closed', () => {
    for (const child of children) if (!child.isDestroyed()) child.destroy();
    void isolated.clearStorageData().catch(() => {});
    resolve();
  }));
  // Hosted Riot/provider pages own all payment inputs. No preload, scraping or token injection.
  return { ready: window.loadURL(url), closed, cancel: () => { if (!window.isDestroyed()) window.destroy(); } };
}
