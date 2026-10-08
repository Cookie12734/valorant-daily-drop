import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const repo = 'Cookie12734/valorant-daily-drop';
const versionPattern = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
export function compareVersions(a, b) {
  const x = versionPattern.exec(a), y = versionPattern.exec(b);
  if (!x || !y) throw new Error('Invalid version');
  for (let i = 1; i <= 3; i++) if (BigInt(x[i]) !== BigInt(y[i])) return BigInt(x[i]) > BigInt(y[i]) ? 1 : -1;
  if (!x[4] || !y[4]) return x[4] === y[4] ? 0 : x[4] ? -1 : 1;
  const p = x[4].split('.'), q = y[4].split('.');
  for (let i = 0; i < Math.max(p.length, q.length); i++) {
    if (p[i] === q[i]) continue;
    if (p[i] === undefined || q[i] === undefined) return p[i] === undefined ? -1 : 1;
    const pn = /^\d+$/.test(p[i]), qn = /^\d+$/.test(q[i]);
    if (pn && qn) return BigInt(p[i]) > BigInt(q[i]) ? 1 : -1;
    if (pn !== qn) return pn ? -1 : 1;
    return p[i] > q[i] ? 1 : -1;
  }
  return 0;
}
export function selectRelease(releases, current) {
  if (!Array.isArray(releases)) throw new Error('Invalid releases');
  return releases.filter(r => !r.draft && versionPattern.test(r.tag_name) &&
    (current.includes('-') || (!r.prerelease && !r.tag_name.includes('-'))) && compareVersions(r.tag_name, current) > 0)
    .sort((a, b) => compareVersions(b.tag_name, a.tag_name))[0] ?? null;
}
function assetURL(asset, tag) {
  const expected = `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/${asset.name}`;
  if (asset.browser_download_url !== expected) throw new Error('配布ファイルのURLを確認できません。');
  return expected;
}
async function download(url, limit, request) {
  const response = await request(url, { signal: AbortSignal.timeout(180000), headers: { 'User-Agent': 'DailyDrop-Updater' } });
  if (!response.ok) throw new Error(`GitHubから取得できません（HTTP ${response.status}）。時間をおいて再試行してください。`);
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > limit) throw new Error('配布ファイルのサイズが上限を超えています。');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
export function verifyChecksum(bytes, checksum, name) {
  const match = /^([a-f0-9]{64})\s+\*?([^\r\n]+)\s*$/i.exec(checksum.trim());
  if (!match || match[2] !== name || createHash('sha256').update(bytes).digest('hex') !== match[1].toLowerCase()) throw new Error('更新ファイルの整合性を確認できません。再試行してください。');
}
export function createUpdater({ currentVersion, installDirectory, supported, quit, request = fetch }) {
  let release, checking, busy = false, lastCheck = 0;
  let state = { currentVersion, supported, phase: 'idle', release: null, error: null };
  const status = () => ({ ...state });
  async function check() {
    if (checking) return checking;
    if (busy || Date.now() - lastCheck < 60000) return status();
    checking = (async () => {
      lastCheck = Date.now(); state.error = null;
      try {
        const response = await request(`https://api.github.com/repos/${repo}/releases?per_page=100`, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'DailyDrop-Updater' }, signal: AbortSignal.timeout(15000) });
        if (!response.ok) throw new Error('GitHubに接続できません。時間をおいて再試行してください。');
        release = selectRelease(await response.json(), currentVersion);
        state.release = release ? { version: release.tag_name.replace(/^v/, ''), name: String(release.name || release.tag_name), notes: String(release.body || 'リリース内容は記載されていません。') } : null;
      } catch (error) { state.error = error.message; }
      return status();
    })().finally(() => { checking = null; });
    return checking;
  }
  async function install() {
    if (busy) return status();
    if (!supported || !release) throw new Error('インストール済みのWindows配布版で更新を確認してください。');
    busy = true; state.phase = 'downloading'; state.error = null;
    const selected = release;
    void (async () => {
      const version = selected.tag_name.replace(/^v/, '');
      const name = `DailyDrop-${version}-win-x64.zip`;
      const asset = selected.assets?.find(a => a.name === name);
      const checksum = selected.assets?.find(a => a.name === `${name}.sha256`);
      if (!asset || !checksum) throw new Error('このリリースにはWindows用ZIPとSHA-256ファイルが必要です。');
      const bytes = await download(assetURL(asset, selected.tag_name), 512 * 1024 * 1024, request);
      const digest = await download(assetURL(checksum, selected.tag_name), 1024, request);
      verifyChecksum(bytes, digest.toString('utf8'), name);
      // Same volume enables atomic directory renames; the previous installation is retained.
      const work = await mkdtemp(join(dirname(installDirectory), '.daily-drop-update-'));
      const archive = join(work, 'release.zip');
      await writeFile(archive, bytes);
      await writeFile(join(work, 'update.ps1'), await readFile(new URL('./update-windows.ps1', import.meta.url)));
      const config = { target: installDirectory, work, archive, folder: name.slice(0, -4), version, pid: process.pid };
      await writeFile(join(work, 'config.json'), JSON.stringify(config));
      state.phase = 'preparing';
      const powershell = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      await promisify(execFile)(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(work, 'update.ps1'), '-Config', join(work, 'config.json'), '-Prepare'], { windowsHide: true, timeout: 180000 });
      const child = spawn(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(work, 'update.ps1'), '-Config', join(work, 'config.json')], { detached: true, stdio: 'ignore', windowsHide: true, cwd: work });
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      child.unref();
      for (let attempt = 0; attempt < 100; attempt++) {
        try { await readFile(join(work, 'ready')); state.phase = 'restarting'; quit(); return; } catch { await new Promise(resolve => setTimeout(resolve, 100)); }
      }
      throw new Error('更新プログラムを起動できませんでした。');
    })().catch(error => { state.phase = 'error'; state.error = error.message; busy = false; });
    return status();
  }
  return { status, check, install, get busy() { return busy; } };
}
