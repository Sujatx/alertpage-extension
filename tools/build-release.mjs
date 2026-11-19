// Builds dist/alertpage-extension.zip (+ .sha256) from extension/. Run: node tools/build-release.mjs
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, rmSync, mkdirSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const ext = join(root, 'extension');
const dist = join(root, 'dist');
const zip = join(dist, 'alertpage-extension.zip');

mkdirSync(dist, { recursive: true });
rmSync(zip, { force: true });

// extension/mock is only empty vendor folders (test leftovers), so skip it.
const items = readdirSync(ext).filter((n) => n !== 'mock');

if (process.platform === 'win32') {
  const list = items.map((n) => `'${join(ext, n)}'`).join(',');
  execFileSync('powershell', ['-NoProfile', '-Command',
    `Compress-Archive -Path ${list} -DestinationPath '${zip}' -Force`], { stdio: 'inherit' });
} else {
  execFileSync('zip', ['-r', zip, ...items], { cwd: ext, stdio: 'inherit' });
}

const hash = createHash('sha256').update(readFileSync(zip)).digest('hex');
writeFileSync(zip + '.sha256', `${hash}  alertpage-extension.zip\n`);
const version = JSON.parse(readFileSync(join(ext, 'manifest.json'), 'utf8')).version;
console.log(`zip:     ${zip}\nversion: ${version}\nsha256:  ${hash}`);
