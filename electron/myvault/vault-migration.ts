import { createHash } from 'node:crypto';
import { closeSync, copyFileSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { describeChromePasswordCsv, MAX_PASSWORD_IMPORT_ISSUES } from '../chrome-importer.js';
import type { ChromePasswordImportResult, ChromePasswordImportReview } from '../types.js';
import { VaultBroker, type BrokerItemInput } from './vault-broker.js';
import type { SafeStorageAdapter } from './vault-store.js';

interface LegacyVaultItem {
  id: string;
  label: string;
  url: string;
  username: string;
  password: string;
  totpSecret?: string;
  updatedAt: string;
}

interface MigrationJournal {
  sourceCiphertextHash: string;
  backupPath: string;
  sourceToTarget: Record<string, string>;
  skippedSourceIds: string[];
  phase: 'backed-up' | 'importing' | 'validated';
  sourceCount: number;
  importedCount: number;
  validatedCount: number;
  updatedAt: string;
}

export interface MigrationConflict { sourceId: string; origin: string; username: string; targetId: string }
export interface MigrationReport {
  sourceCount: number;
  importedCount: number;
  skippedCount: number;
  validatedCount: number;
  conflicts: MigrationConflict[];
  backupPath: string;
  journalPhase: MigrationJournal['phase'];
}

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function origin(value: string): string {
  const parsed = new URL(value);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('A legacy login has an unsupported origin');
  return parsed.origin;
}

function migrationKey(item: Pick<LegacyVaultItem, 'url' | 'username'>): string {
  return `${origin(item.url)}\n${item.username.normalize('NFKC').trim().toLocaleLowerCase('en-US')}`;
}

function atomicWrite(filePath: string, value: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  writeFileSync(temporary, value, { encoding: 'utf8', mode: 0o600 });
  renameSync(temporary, filePath);
}

function parseLegacy(value: unknown): LegacyVaultItem[] {
  if (!Array.isArray(value)) throw new Error('The legacy vault has an invalid structure');
  return value.map((candidate) => {
    if (!candidate || typeof candidate !== 'object') throw new Error('The legacy vault has an invalid record');
    const item = candidate as Partial<LegacyVaultItem>;
    if (typeof item.id !== 'string' || typeof item.label !== 'string' || typeof item.url !== 'string' || typeof item.username !== 'string' || typeof item.password !== 'string' || typeof item.updatedAt !== 'string' || (item.totpSecret !== undefined && typeof item.totpSecret !== 'string')) throw new Error('The legacy vault has an invalid record');
    origin(item.url);
    if (!Number.isFinite(Date.parse(item.updatedAt))) throw new Error('The legacy vault has an invalid timestamp');
    return item as LegacyVaultItem;
  });
}

/** Chrome exports are a few MB even for thousands of logins. */
const MAX_CHROME_CSV_BYTES = 20 * 1024 * 1024;

function readChromeCsv(path: string): Buffer {
  let file: number | undefined;
  try {
    file = openSync(path, 'r');
    const stats = fstatSync(file);
    if (!stats.isFile() || stats.size > MAX_CHROME_CSV_BYTES) throw new Error('Choose a Chrome password export up to 20 MB.');
    const bytes = Buffer.alloc(stats.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const read = readSync(file, bytes, offset, bytes.length - offset, null);
      if (!read) break;
      offset += read;
    }
    if (offset !== stats.size) {
      bytes.fill(0);
      throw new Error('The CSV changed while reading it. Choose the file again.');
    }
    return bytes.subarray(0, offset);
  } catch (error) {
    if (error instanceof Error && 'code' in error) throw new Error('The selected password CSV could not be read. Choose it again.');
    throw error;
  } finally {
    if (file !== undefined) closeSync(file);
  }
}

export class VaultMigrationService {
  constructor(
    private readonly legacyPath: string,
    private readonly journalPath: string,
    private readonly safeStorage: SafeStorageAdapter,
    private readonly broker: VaultBroker,
    private readonly now: () => Date = () => new Date(),
  ) {}

  isLegacyAvailable(): boolean { return existsSync(this.legacyPath); }

  async migrateLegacy(decisions: Record<string, 'replace' | 'skip'> = {}): Promise<MigrationReport> {
    if (!this.safeStorage.isEncryptionAvailable()) throw new Error('OS encryption is required for migration');
    if (!existsSync(this.legacyPath)) throw new Error('No legacy Private Browser vault was found');
    const ciphertext = readFileSync(this.legacyPath);
    const sourceHash = sha256(ciphertext);
    let journal = this.loadJournal();
    if (!journal) {
      const backupPath = `${this.legacyPath}.migration-backup-${this.now().toISOString().replace(/[:.]/g, '-')}`;
      copyFileSync(this.legacyPath, backupPath);
      if (sha256(readFileSync(backupPath)) !== sourceHash) throw new Error('Legacy vault backup verification failed');
      journal = { sourceCiphertextHash: sourceHash, backupPath, sourceToTarget: {}, skippedSourceIds: [], phase: 'backed-up', sourceCount: 0, importedCount: 0, validatedCount: 0, updatedAt: this.now().toISOString() };
      this.saveJournal(journal);
    } else if (journal.sourceCiphertextHash !== sourceHash) {
      throw new Error('The legacy vault changed after migration began');
    }
    const items = parseLegacy(JSON.parse(this.safeStorage.decryptString(Buffer.from(ciphertext.toString('utf8'), 'base64'))));
    journal.sourceCount = items.length;
    journal.phase = 'importing';
    this.saveJournal(journal);
    const conflicts: MigrationConflict[] = [];
    const existing = this.broker.searchMetadata();
    for (const item of items) {
      if (journal.sourceToTarget[item.id] || journal.skippedSourceIds.includes(item.id)) continue;
      const normalizedOrigin = origin(item.url);
      const match = existing.find((candidate) => candidate.url && `${candidate.url}\n${candidate.username.normalize('NFKC').trim().toLocaleLowerCase('en-US')}` === migrationKey(item));
      if (match) {
        const samePassword = this.broker.resolveSecretForTrustedOperation(match.id, 'password') === item.password;
        let sameTotp = !item.totpSecret && !match.hasTotp;
        if (item.totpSecret && match.hasTotp) sameTotp = this.broker.resolveSecretForTrustedOperation(match.id, 'totp-secret') === item.totpSecret;
        if (samePassword && sameTotp) { journal.sourceToTarget[item.id] = match.id; this.saveJournal(journal); continue; }
        const decision = decisions[item.id];
        if (!decision) { conflicts.push({ sourceId: item.id, origin: normalizedOrigin, username: item.username, targetId: match.id }); continue; }
        if (decision === 'skip') { journal.skippedSourceIds.push(item.id); this.saveJournal(journal); continue; }
      }
      const saved = await this.broker.saveLogin({ id: match?.id, title: item.label, url: normalizedOrigin, username: item.username, password: item.password, totp: item.totpSecret ? { secret: item.totpSecret, algorithm: 'SHA-1', digits: 6, period: 30 } : undefined, updatedAt: item.updatedAt });
      journal.sourceToTarget[item.id] = saved.id;
      journal.importedCount += 1;
      this.saveJournal(journal);
    }
    journal.validatedCount = items.filter((item) => journal.sourceToTarget[item.id] || journal.skippedSourceIds.includes(item.id)).length;
    if (!conflicts.length && journal.validatedCount === items.length) journal.phase = 'validated';
    this.saveJournal(journal);
    return this.report(journal, conflicts);
  }

  async importChromeCsv(filePath: string): Promise<Omit<MigrationReport, 'backupPath' | 'journalPhase'>> {
    const plan = this.planChromeCsv(filePath);
    const imported = await this.broker.importLogins(plan.fresh, plan.revision);
    const sourceCount = plan.review.sourceCount;
    return { sourceCount, importedCount: imported.length, skippedCount: sourceCount - imported.length, validatedCount: sourceCount, conflicts: [] };
  }

  reviewChromeCsv(filePath: string): { digest: string; revision: string; review: Omit<ChromePasswordImportReview, 'id'> } {
    const { digest, revision, review } = this.planChromeCsv(filePath);
    return { digest, revision, review };
  }

  async importReviewedChromeCsv(filePath: string, digest: string, revision: string): Promise<ChromePasswordImportResult> {
    const plan = this.planChromeCsv(filePath, digest, revision);
    const imported = await this.broker.importLogins(plan.fresh, revision);
    return { imported: imported.length, skipped: plan.review.skipped };
  }

  private planChromeCsv(filePath: string, expectedDigest?: string, expectedRevision?: string) {
    const revision = this.broker.loginRevision();
    if (expectedRevision !== undefined && revision !== expectedRevision) throw new Error('MyVault changed. Review the password file again.');
    const bytes = readChromeCsv(filePath);
    const digest = sha256(bytes);
    const parsed = (() => {
      try {
        if (expectedDigest !== undefined && digest !== expectedDigest) throw new Error('The CSV changed. Review it again.');
        return describeChromePasswordCsv(bytes.toString('utf8'));
      } finally {
        bytes.fill(0);
      }
    })();
    const key = (url: string | undefined, username: string) => JSON.stringify([url, username.normalize('NFKC').trim()]);
    const saved = new Set(this.broker.searchMetadata().map((item) => key(item.url, item.username)));
    const seen = new Set<string>();
    const fresh: BrokerItemInput[] = [];
    for (const { entry, login: row } of parsed.items) {
      const normalizedOrigin = origin(row.url);
      const match = key(normalizedOrigin, row.username);
      const reason = saved.has(match) ? 'already-saved' : seen.has(match) ? 'duplicate-in-file' : undefined;
      if (reason) {
        parsed.skipped[reason] = (parsed.skipped[reason] ?? 0) + 1;
        if (parsed.issues.length < MAX_PASSWORD_IMPORT_ISSUES) {
          parsed.issues.push({ entry, reason, origin: normalizedOrigin, username: row.username });
        }
        continue;
      }
      seen.add(match);
      fresh.push({ title: row.label, url: normalizedOrigin, username: row.username, password: row.password, notes: row.note });
    }
    const review = { sourceCount: parsed.sourceCount, toImport: fresh.length, skipped: parsed.skipped,
      issues: parsed.issues.sort((a, b) => a.entry - b.entry) };
    return { digest, revision, review, fresh };
  }

  cleanupLegacyAfterConfirmation(confirmed: boolean): boolean {
    const journal = this.loadJournal();
    if (!confirmed || journal?.phase !== 'validated' || !existsSync(this.legacyPath)) return false;
    unlinkSync(this.legacyPath);
    return true;
  }

  private loadJournal(): MigrationJournal | undefined {
    if (!existsSync(this.journalPath)) return undefined;
    const value = JSON.parse(this.safeStorage.decryptString(Buffer.from(readFileSync(this.journalPath, 'utf8'), 'base64'))) as MigrationJournal;
    if (!value || typeof value.sourceCiphertextHash !== 'string' || typeof value.backupPath !== 'string' || typeof value.sourceToTarget !== 'object') throw new Error('The migration journal is unreadable');
    return value;
  }

  private saveJournal(journal: MigrationJournal): void {
    journal.updatedAt = this.now().toISOString();
    atomicWrite(this.journalPath, this.safeStorage.encryptString(JSON.stringify(journal)).toString('base64'));
  }

  private report(journal: MigrationJournal, conflicts: MigrationConflict[]): MigrationReport {
    return { sourceCount: journal.sourceCount, importedCount: journal.importedCount, skippedCount: journal.skippedSourceIds.length, validatedCount: journal.validatedCount, conflicts, backupPath: journal.backupPath, journalPhase: journal.phase };
  }
}
