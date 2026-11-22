import { constantTimeEqual } from './auth';

type Mode = 'public' | 'private';

const enrollmentLifetime = 15 * 60;
const idPattern = '[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}';
const deviceId = new RegExp(`^${idPattern}$`);
const enrollmentPattern = new RegExp(`^pbenr_(${idPattern})_[A-Za-z0-9_-]{43}$`);
const credentialPattern = new RegExp(`^pbdev_(${idPattern})_[A-Za-z0-9_-]{43}$`);

const epoch = () => Math.floor(Date.now() / 1_000);

function randomSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

async function digest(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function distributionMode(database: D1Database): Promise<Mode> {
  const row = await database.prepare('SELECT mode FROM release_distribution WHERE singleton = 1').first<{ mode: Mode }>();
  if (row?.mode === 'public' || row?.mode === 'private') return row.mode;
  throw new Error('Release distribution is unavailable');
}

export async function acceptDownloadDevice(database: D1Database, credential: string, recordUse: boolean): Promise<boolean> {
  const id = credentialPattern.exec(credential)?.[1];
  if (!id) return false;
  const row = await database.prepare('SELECT credential_hash, used_at FROM release_devices WHERE id = ?1 AND enrolled_at IS NOT NULL AND revoked_at IS NULL')
    .bind(id).first<{ credential_hash: string; used_at?: number }>();
  if (!row || !await constantTimeEqual(await digest(credential), row.credential_hash)) return false;
  const now = epoch();
  if (recordUse && (!row.used_at || now - row.used_at >= 3_600)) {
    await database.prepare('UPDATE release_devices SET used_at = ?1 WHERE id = ?2 AND revoked_at IS NULL').bind(now, id).run();
  }
  return true;
}

export async function issueDownloadEnrollment(database: D1Database, value: unknown): Promise<{ id: string; label: string; code: string; expiresAt: string } | undefined> {
  const label = typeof value === 'string' ? value.trim() : '';
  if (!label || label.length > 80 || /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(label)) return undefined;
  const id = crypto.randomUUID();
  const code = `pbenr_${id}_${randomSecret()}`;
  const now = epoch();
  const expires = now + enrollmentLifetime;
  await database.prepare('INSERT INTO release_devices (id, label, enrollment_hash, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5)')
    .bind(id, label, await digest(code), now, expires).run();
  return { id, label, code, expiresAt: new Date(expires * 1_000).toISOString() };
}

export async function redeemDownloadEnrollment(database: D1Database, code: string, credential: string): Promise<boolean> {
  const id = enrollmentPattern.exec(code)?.[1];
  if (!id || credentialPattern.exec(credential)?.[1] !== id) return false;
  const codeHash = await digest(code);
  const credentialHash = await digest(credential);
  const accepted = await database.prepare(`UPDATE release_devices SET credential_hash = ?1, enrolled_at = ?2
      WHERE id = ?3 AND enrollment_hash = ?4 AND expires_at > ?2 AND enrolled_at IS NULL AND revoked_at IS NULL
      RETURNING id`).bind(credentialHash, epoch(), id, codeHash).first<{ id: string }>();
  if (accepted) return true;
  // A network retry uses the same generated device credential. The code alone cannot claim the device again.
  return Boolean(await database.prepare('SELECT id FROM release_devices WHERE id = ?1 AND enrollment_hash = ?2 AND credential_hash = ?3 AND revoked_at IS NULL')
    .bind(id, codeHash, credentialHash).first<{ id: string }>());
}

export async function distributionDevices(database: D1Database) {
  const { results } = await database.prepare(`SELECT id, label, created_at, expires_at, enrolled_at, used_at, revoked_at
    FROM release_devices ORDER BY created_at DESC, id LIMIT 250`).all<{
      id: string; label: string; created_at: number; expires_at: number; enrolled_at: number | null; used_at: number | null; revoked_at: number | null;
    }>();
  const iso = (value: number | null) => value === null ? undefined : new Date(value * 1_000).toISOString();
  return results.map((row) => ({ id: row.id, label: row.label, createdAt: iso(row.created_at), expiresAt: iso(row.expires_at),
    enrolledAt: iso(row.enrolled_at), lastUsedAt: iso(row.used_at), revokedAt: iso(row.revoked_at) }));
}

export async function revokeDownloadDevice(database: D1Database, id: string): Promise<boolean> {
  if (!deviceId.test(id)) return false;
  return Boolean(await database.prepare('UPDATE release_devices SET revoked_at = COALESCE(revoked_at, ?1) WHERE id = ?2 RETURNING id')
    .bind(epoch(), id).first<{ id: string }>());
}

export async function selectDistributionMode(database: D1Database, mode: Mode): Promise<boolean> {
  // Prevent accidental lockout by requiring a device already proven against the feed before a private rollout.
  const updated = await database.prepare(`UPDATE release_distribution SET mode = ?1, changed_at = ?2 WHERE singleton = 1
    AND (?1 = 'public' OR EXISTS (SELECT 1 FROM release_devices WHERE revoked_at IS NULL AND enrolled_at IS NOT NULL AND used_at IS NOT NULL))
    RETURNING mode`).bind(mode, epoch()).first<{ mode: Mode }>();
  return updated?.mode === mode;
}
