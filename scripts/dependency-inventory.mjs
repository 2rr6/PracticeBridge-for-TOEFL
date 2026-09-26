import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const root = new URL('../', import.meta.url);
const lockBytes = await readFile(new URL('package-lock.json', root));
const lock = JSON.parse(lockBytes);
const packages = Object.entries(lock.packages).filter(([name]) => name).map(([installPath, value]) => ({
  installPath, name: installPath.slice(installPath.lastIndexOf('node_modules/') + 13), version: value.version,
  development: value.dev === true, optional: value.optional === true, license: value.license ?? null,
  integrity: value.integrity ?? null,
}));
const inventory = { formatVersion: 1, lockfileCanonicalSha256: createHash('sha256').update(JSON.stringify(lock)).digest('hex'),
  runtime: lock.packages[''].dependencies, development: lock.packages[''].devDependencies, packages };
const output = new URL('docs/development/DEPENDENCIES.json', root);
await mkdir(new URL('docs/development/', root), { recursive: true });
await writeFile(output, JSON.stringify(inventory, null, 2) + '\n');
console.log(`Dependency inventory: ${fileURLToPath(output)}; ${packages.length} locked entries. This is not an advisory scan.`);
