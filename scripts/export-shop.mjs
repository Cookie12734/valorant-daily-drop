import { mkdir, writeFile, rename } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { fetchShopSnapshot } from './riot-client.mjs';

try {
  const snapshot = await fetchShopSnapshot();
  const directory = fileURLToPath(new URL('../exports/', import.meta.url));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, 'shop.json.tmp');
  const output = join(directory, 'shop.json');
  await writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, output);
  console.log(`ショップを書き出しました: ${output}`);
} catch {
  console.error('ショップを書き出せません。Windows で Riot Client と VALORANT を起動し、ログイン後にもう一度お試しください。');
  process.exitCode = 1;
}
