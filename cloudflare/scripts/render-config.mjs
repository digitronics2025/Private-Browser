import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const directory = dirname(dirname(fileURLToPath(import.meta.url)));
const databaseId = process.env.CLOUDFLARE_D1_DATABASE_ID?.trim();
if (!databaseId || !/^[a-f0-9-]{36}$/i.test(databaseId)) throw new Error('CLOUDFLARE_D1_DATABASE_ID is missing or invalid');
const source = readFileSync(join(directory, 'wrangler.jsonc'), 'utf8');
const rendered = source.replace('00000000-0000-0000-0000-000000000000', databaseId);
writeFileSync(join(directory, 'wrangler.deploy.jsonc'), rendered, { mode: 0o600 });
