import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, lstat, mkdir, open, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

if (process.platform !== 'win32') throw new Error('Run npm run package:win on Windows with the Windows Electron runtime installed.');
const root = fileURLToPath(new URL('../', import.meta.url));
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
assert.match(pkg.version, /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/);
const runtime = join(root, 'node_modules', 'electron', 'dist');
assert.equal((await readFile(join(runtime, 'version'), 'utf8')).trim(), pkg.dependencies.electron);
const executable = await open(join(runtime, 'electron.exe'));
try {
  const header = (await executable.read(Buffer.alloc(64), 0, 64, 0)).buffer;
  const machine = (await executable.read(Buffer.alloc(2), 0, 2, header.readUInt32LE(0x3c) + 4)).buffer;
  assert.equal(machine.readUInt16LE(), 0x8664, 'An x64 Electron runtime is required.');
} finally { await executable.close(); }

const releases = join(root, 'releases');
const name = `DailyDrop-${pkg.version}-win-x64`;
const output = join(releases, name);
const archive = `${output}.zip`;
// Only these generated paths may be replaced when packaging again.
assert.equal(dirname(output), releases);
assert.equal(dirname(archive), releases);
await mkdir(releases, { recursive: true });
await rm(output, { recursive: true, force: true });
await mkdir(output);

// Allowlist application files: exports, profiles, cookies, .env and tests never enter the package.
const appFiles = [
  'scripts/updater.mjs', 'scripts/update-windows.ps1', 'dist/update.mjs',
  'scripts/topup.mjs', 'scripts/payment-window.mjs', 'scripts/compact.css', 'scripts/night-market.mjs', 'scripts/purchase.mjs',
  'scripts/desktop.mjs', 'scripts/local-server.mjs', 'scripts/riot-login.mjs', 'scripts/riot-client.mjs',
  'dist/accessory.mjs', 'dist/index.html', 'dist/app.mjs', 'dist/shop.mjs', 'dist/style.css', 'dist/tokens.css', 'dist/favicon.svg',
  'dist/assets/kuronami.png', 'dist/assets/oni.png', 'dist/assets/prime.png', 'dist/assets/reaver.png',
];
const runtimeFiles = [
  'chrome_100_percent.pak', 'chrome_200_percent.pak', 'd3dcompiler_47.dll', 'dxcompiler.dll', 'dxil.dll',
  'ffmpeg.dll', 'icudtl.dat', 'LICENSE', 'LICENSES.chromium.html', 'resources.pak', 'snapshot_blob.bin',
  'v8_context_snapshot.bin', 'version', 'vk_swiftshader_icd.json', 'vk_swiftshader.dll', 'vulkan-1.dll',
];
for (const entry of await readdir(join(runtime, 'locales'), { withFileTypes: true })) {
  if (entry.isFile() && entry.name.endsWith('.pak')) runtimeFiles.push(`locales/${entry.name}`);
}
const files = [
  ...runtimeFiles.map(path => [join(runtime, path), join(output, path)]),
  [join(runtime, 'electron.exe'), join(output, 'DailyDrop.exe')],
  ...appFiles.map(path => [join(root, path), join(output, 'resources', 'app', path)]),
];
for (const [source, destination] of files) {
  assert.ok((await lstat(source)).isFile(), `Package source must be a regular file: ${source}`);
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, destination);
}
const manifest = join(output, 'resources', 'app', 'package.json');
await writeFile(manifest, `${JSON.stringify({ name: pkg.name, version: pkg.version, private: true, type: 'module', main: pkg.main }, null, 2)}\n`);

// Runnable package check: its entire inventory must match the allowlist.
const actual = (await readdir(output, { recursive: true, withFileTypes: true }))
  .filter(entry => entry.isFile()).map(entry => relative(output, join(entry.parentPath, entry.name))).sort();
const expected = [...files.map(([, path]) => relative(output, path)), relative(output, manifest)].sort();
assert.deepEqual(actual, expected);
console.log(`Packaged ${actual.length} files in ${output}`);
await promisify(execFile)('tar.exe', ['-a', '-c', '-f', archive, '-C', releases, name], { windowsHide: true });
const hash = createHash('sha256');
for await (const chunk of createReadStream(archive)) hash.update(chunk);
const checksum = hash.digest('hex');
await writeFile(`${archive}.sha256`, `${checksum}  ${name}.zip\n`);
console.log(`ZIP: ${archive}\nSHA256: ${checksum}`);
