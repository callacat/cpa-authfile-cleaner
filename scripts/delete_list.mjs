import { request } from 'undici';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const configPath = resolve(process.cwd(), 'cleaner.config.json');
const config = JSON.parse(await readFile(configPath, 'utf8'));
const base = String(config.baseUrl ?? '').replace(/\/$/, '');
const key = process.env.MANAGEMENT_KEY || process.env.KEY || config.managementKey;
const dryRun = String(process.env.DRY_RUN ?? String(config.dryRun ?? true)).toLowerCase() !== 'false';

if (!base) {
  console.error(`missing baseUrl in ${configPath}`);
  process.exit(2);
}
if (!key) {
  console.error(`missing managementKey in ${configPath} or env MANAGEMENT_KEY/KEY`);
  process.exit(2);
}

const list = (await readFile('to-delete.txt', 'utf8'))
  .split(/\r?\n/)
  .map((s) => s.trim())
  .filter(Boolean);

let ok = 0;
let failed = 0;
const failures = [];

for (const name of list) {
  const url = `${base}/auth-files?name=${encodeURIComponent(name)}`;
  if (dryRun) {
    console.log(`[DRY] DELETE ${name}`);
    continue;
  }

  const res = await request(url, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${key}`, accept: 'application/json' }
  });
  const text = await res.body.text();

  if (res.statusCode >= 200 && res.statusCode < 300) {
    ok++;
    console.log(`[OK] ${name}`);
  } else {
    failed++;
    const entry = { name, status: res.statusCode, body: text.slice(0, 500) };
    failures.push(entry);
    console.log(`[FAIL] ${name} status=${res.statusCode} body=${text.slice(0, 120)}`);
  }
}

console.log(`done delete ok=${ok} failed=${failed} total=${list.length}`);
if (failed) {
  console.log('failures:', JSON.stringify(failures, null, 2));
  process.exitCode = 1;
}
