import { requireHttpsEndpoint } from './require-https-endpoint.mjs';

/**
 * Makes an existing release active again. The publish job calls it when the
 * live end-to-end check of the release it just activated fails, so users are
 * served the previous, verified installer instead of a broken one (F-50).
 */
const [id] = process.argv.slice(2);
const endpoint = requireHttpsEndpoint(process.env.PRIVATE_BROWSER_DOWNLOAD_URL);
const adminKey = process.env.PRIVATE_BROWSER_ADMIN_API_KEY;
if (!id || !/^stable-\d+\.\d+\.\d+-\d+$/.test(id) || !endpoint || !adminKey) {
  throw new Error('Release activation needs an exact stable release id, the service URL and the admin key');
}
const response = await fetch(`${endpoint}/api/v1/admin/releases/activate`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-api-key': adminKey },
  body: JSON.stringify({ id, channel: 'stable' }),
  redirect: 'error',
  signal: AbortSignal.timeout(30_000),
});
if (!response.ok) throw new Error(`Release activation failed (${response.status}): ${(await response.text()).slice(0, 500)}`);
process.stdout.write(`${JSON.stringify(await response.json())}\n`);
