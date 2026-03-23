import { request } from 'undici';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const configPath = resolve(process.cwd(), 'cleaner.config.json');
const config = JSON.parse(await readFile(configPath, 'utf8'));
const base = String(config.baseUrl ?? '').replace(/\/$/, '');
const key = process.env.MANAGEMENT_KEY || process.env.KEY || config.managementKey;
const onlyProvider = String(config.onlyProvider ?? 'codex').toLowerCase();

if (!base) {
  console.error(`missing baseUrl in ${configPath}`);
  process.exit(2);
}
if (!key) {
  console.error(`missing managementKey in ${configPath} or env MANAGEMENT_KEY/KEY`);
  process.exit(2);
}

const res = await request(base + '/auth-files', { headers: { authorization: `Bearer ${key}` } });
const text = await res.body.text();
if (res.statusCode !== 200) {
  console.error('list failed', res.statusCode, text.slice(0, 500));
  process.exit(1);
}
const data = JSON.parse(text);
const files = (data.files ?? []).filter((f) => String(f.provider ?? f.type ?? '').toLowerCase() === onlyProvider);

const deletable = [];
for (const f of files) {
  const sm = String(f.status_message ?? f.statusMessage ?? '').trim();
  if (!sm) continue;

  try {
    const parsed = JSON.parse(sm);
    if (containsStatus401(parsed)) {
      deletable.push({ name: f.name, auth_index: f.auth_index });
    }
  } catch {
    // ignore malformed status_message
  }
}

console.log(JSON.stringify({ provider: onlyProvider, total: files.length, deletable: deletable.length, sample: deletable.slice(0, 20) }, null, 2));

function containsStatus401(root) {
  const queue = [root];
  const seen = new Set();

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);

    const status = normalizeStatus(current.status);
    if (status === 401) return true;

    if (current.error && typeof current.error === 'object') queue.push(current.error);
    if (current.details && typeof current.details === 'object') queue.push(current.details);
    if (current.data && typeof current.data === 'object') queue.push(current.data);
  }

  return false;
}

function normalizeStatus(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value.trim());
  return undefined;
}
