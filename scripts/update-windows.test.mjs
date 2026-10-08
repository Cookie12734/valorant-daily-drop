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
});
