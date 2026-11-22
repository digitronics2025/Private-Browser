import { requireProductionReleaseEndpoint } from './require-https-endpoint.mjs';

const [id] = process.argv.slice(2);
const endpoint = requireProductionReleaseEndpoint(process.env.PRIVATE_BROWSER_DOWNLOAD_URL);
const adminKey = process.env.PRIVATE_BROWSER_ADMIN_API_KEY;
if (!id || !/^stable-\d+\.\d+\.\d+-\d+$/.test(id) || !adminKey) {
  throw new Error('Suspension requires the exact failed stable release ID and the admin key.');
}
const response = await fetch(endpoint + '/api/v1/admin/releases/suspend', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-api-key': adminKey },
  body: JSON.stringify({ id }),
  redirect: 'error',
  signal: AbortSignal.timeout(30_000),
});
if (!response.ok) throw new Error(`Failed to suspend the candidate (HTTP ${response.status}).`);
process.stdout.write(JSON.stringify(await response.json()) + '\n');
