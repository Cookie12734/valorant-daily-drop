import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const script = fileURLToPath(new URL('./update-windows.ps1', import.meta.url));
const powershell = join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const ps = (args) => exec(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', ...args], { windowsHide: true, timeout: 30000 });
test('Windows archive preparation rejects traversal and stages a complete package; helper replaces and restarts', { skip: process.platform !== 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'daily-drop-update-test-日本語-'));
  const work = await mkdtemp(join(root, '.daily-drop-update-'));
  const target = join(root, 'installed');
  await mkdir(target);
  await writeFile(join(target, 'old.txt'), 'previous version');
  const config = join(work, 'config.json');
  const archive = join(work, 'release.zip');
  const fixture = join(root, 'fixture.ps1');
  // Build an inert executable that records successful launch, never a real app/profile.
  await writeFile(fixture, `param([string]$Root, [string]$Archive, [switch]$Unsafe)
Add-Type -AssemblyName System.IO.Compression.FileSystem
$exe = Join-Path $Root 'fixture.exe'
if (-not (Test-Path -LiteralPath $exe)) {
  Add-Type -TypeDefinition 'using System; using System.IO; public class Fixture { public static void Main() { File.WriteAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "started.txt"), "started"); } }' -OutputAssembly $exe -OutputType WindowsApplication
}
$zip = [IO.Compression.ZipFile]::Open($Archive, 'Create')
try {
  $folder = 'DailyDrop-1.1.0-win-x64/'
  if ($Unsafe) { $entry = $zip.CreateEntry('../escaped.txt') } else {
    [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $exe, ($folder + 'DailyDrop.exe')) | Out-Null
    $entry = $zip.CreateEntry($folder + 'resources/app/package.json')
  }
  $writer = New-Object IO.StreamWriter($entry.Open())
  $writer.Write('{"name":"valorant-daily-drop","version":"1.1.0"}')
  $writer.Dispose()
} finally { $zip.Dispose() }
`);
  await writeFile(config, JSON.stringify({ work, target, archive, folder: 'DailyDrop-1.1.0-win-x64', version: '1.1.0', pid: 2147483647 }));
  await ps(['-File', fixture, '-Root', root, '-Archive', archive]);
  // Exercise the real controller through parent exit, including Electron's GUI process.
  // A detached PowerShell can exit 0 without ever executing the script on Windows.
  for (const runtime of [process.execPath, fileURLToPath(new URL('../node_modules/electron/dist/electron.exe', import.meta.url))]) {
    const installRoot = await mkdtemp(join(root, 'parent-exit-'));
    const installDirectory = join(installRoot, 'installed');
    await mkdir(installDirectory);
    await writeFile(join(installDirectory, 'old.txt'), 'previous version');
    const runner = join(installRoot, 'runner.mjs');
    const updaterURL = new URL('./updater.mjs', import.meta.url).href;
    await writeFile(runner, `
import { createUpdater } from ${JSON.stringify(updaterURL)};
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const name = 'DailyDrop-1.1.0-win-x64.zip';
const bytes = await readFile(${JSON.stringify(archive)});
const checksum = createHash('sha256').update(bytes).digest('hex') + '  ' + name;
const base = 'https://github.com/Cookie12734/valorant-daily-drop/releases/download/v1.1.0/';
async function run(quit) {
  const timer = setTimeout(()=>process.exit(2), 20000);
  const updater = createUpdater({ currentVersion:'1.0.0', supported:true, installDirectory:${JSON.stringify(installDirectory)}, quit:()=>{ clearTimeout(timer); quit(); }, request:async url=> {
    if (url.startsWith('https://api.github.com/')) return new Response(JSON.stringify([{tag_name:'v1.1.0', assets:[name, name+'.sha256'].map(name=>({name,browser_download_url:base+name}))}]));
    return new Response(url.endsWith('.sha256') ? checksum : bytes);
  }});
  await updater.check(); await updater.install();
  const monitor = setInterval(()=>{const state=updater.status(); if(state.phase==='error'){ console.error(state.error); process.exit(1); }}, 100);
  monitor.unref();
}
if(process.versions.electron){
  const {app}=await import('electron');
  app.setPath('userData', ${JSON.stringify(join(installRoot, 'profile'))});
  app.whenReady().then(()=>run(()=>app.quit()));
} else await run(()=>process.exit(0));
`);
    await exec(runtime, [runner], { windowsHide: true, timeout: 30000 });
    for (let i = 0; i < 100; i++) {
      try { await access(join(installDirectory, 'started.txt')); break; } catch { await new Promise(resolve => setTimeout(resolve, 100)); }
    }
    assert.equal(await readFile(join(installDirectory, 'started.txt'), 'utf8'), 'started', `${runtime} helper survives parent exit and launches the replacement`);
  }
  await ps(['-File', script, '-Config', config, '-Prepare']);
  await ps(['-File', script, '-Config', config]);
  assert.equal(await readFile(join(work, 'previous/old.txt'), 'utf8'), 'previous version');
  for (let i = 0; i < 30; i++) {
    try { await access(join(target, 'started.txt')); break; } catch { await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  assert.equal(await readFile(join(target, 'started.txt'), 'utf8'), 'started');
  const unsafeWork = await mkdtemp(join(root, '.daily-drop-update-'));
  const unsafeArchive = join(unsafeWork, 'release.zip');
  const unsafeConfig = join(unsafeWork, 'config.json');
  await writeFile(unsafeConfig, JSON.stringify({ work: unsafeWork, target, archive: unsafeArchive, folder: 'DailyDrop-1.1.0-win-x64', version: '1.1.0' }));
  await ps(['-File', fixture, '-Root', root, '-Archive', unsafeArchive, '-Unsafe']);
  await assert.rejects(ps(['-File', script, '-Config', unsafeConfig, '-Prepare']));
  await assert.rejects(access(join(root, 'escaped.txt')));
  // A launch failure after the old directory was moved must restore it.
  const failedWork = await mkdtemp(join(root, '.daily-drop-update-'));
  const failedConfig = join(failedWork, 'config.json');
  const failedStage = join(failedWork, 'DailyDrop-1.2.0-win-x64');
  await mkdir(failedStage);
  await writeFile(join(failedStage, 'DailyDrop.exe'), 'invalid executable');
  await writeFile(failedConfig, JSON.stringify({ work: failedWork, target, folder: 'DailyDrop-1.2.0-win-x64', pid: 2147483647 }));
  await assert.rejects(ps(['-File', script, '-Config', failedConfig, '-NoDialog']));
  assert.equal(await readFile(join(target, 'resources/app/package.json'), 'utf8'), '{"name":"valorant-daily-drop","version":"1.1.0"}');
  assert.ok((await readFile(join(failedWork, 'error.txt'))).length);
  // A startup attempt cancelled by the app must never replace the installation.
  const cancelledWork = await mkdtemp(join(root, '.daily-drop-update-'));
  const cancelledConfig = join(cancelledWork, 'config.json');
  await writeFile(cancelledConfig, JSON.stringify({ work: cancelledWork, target, folder: 'DailyDrop-1.2.0-win-x64', pid: 2147483647 }));
  await writeFile(join(cancelledWork, 'cancelled'), 'cancelled');
  await ps(['-File', script, '-Config', cancelledConfig, '-NoDialog']);
  await assert.rejects(access(join(cancelledWork, 'ready')));
  assert.equal(await readFile(join(target, 'resources/app/package.json'), 'utf8'), '{"name":"valorant-daily-drop","version":"1.1.0"}');
});
