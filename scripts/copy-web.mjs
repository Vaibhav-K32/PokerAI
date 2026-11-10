import { createHash } from 'node:crypto';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cp, readdir, readFile, writeFile } from 'node:fs/promises';

const dist = new URL('../dist/', import.meta.url);
const web = new URL('../web/', import.meta.url);
const template = new URL('./sw-template.js', import.meta.url);
await cp(web, dist, { recursive: true });
const files = (await readdir(dist, { recursive: true, withFileTypes: true }))
  .filter(entry => entry.isFile() && entry.name !== 'sw.js')
  .map(entry => './' + relative(fileURLToPath(dist), join(entry.parentPath, entry.name)).split('\\').join('/'))
  .sort();

const source = await readFile(template, 'utf8');
const hash = createHash('sha256').update(source).update(JSON.stringify(files));
for (const file of files) hash.update(await readFile(new URL(file, dist)));
const worker = source.replace('__REVISION__', hash.digest('hex').slice(0, 16))
  .replace('__FILES__', JSON.stringify(files));
await writeFile(new URL('sw.js', dist), worker);
