import { useState } from 'react';
import type { AccountSpaceId, VaultHealthIssue, VaultHealthReport, VaultItemMeta } from '../../electron/types';
import { domainFromUrl } from '../lib/format';

const RESULTS_PER_PAGE = 20;
const labels: Record<VaultHealthIssue, string> = {
  'duplicate-login': 'Possible duplicate login',
  'missing-origin': 'Missing or invalid website',
  'reused-password': 'Password reused by another login',
  'weak-password': 'Password is short or repeats one character',
};

const loginCount = (count: number) => count + (count === 1 ? ' login' : ' logins');

export function VaultHealthPanel({ accountId, items, onChange, onToast }: {
  accountId: AccountSpaceId;
  items: VaultItemMeta[];
  onChange: () => Promise<void>;
  onToast: (message: string, kind?: 'ok' | 'error') => void;
}) {
  const [report, setReport] = useState<VaultHealthReport>();
  const [limit, setLimit] = useState(RESULTS_PER_PAGE);
  const [busy, setBusy] = useState(false);
  const namedItems = new Map(items.map((item) => [item.id, item]));
  const findings = report?.findings.filter((finding) => namedItems.has(finding.id)) ?? [];

  const review = async (change?: () => Promise<boolean>) => {
    setBusy(true);
    try {
      if (change) {
        if (!await change()) return;
        await onChange();
      } else {
        setLimit(RESULTS_PER_PAGE);
      }
      setReport(await window.privateBrowser.checkVaultHealth(accountId));
    } catch (error) {
      onToast(error instanceof Error ? error.message : 'Could not check MyVault health.', 'error');
    } finally {
      setBusy(false);
    }
  };

  return <section className="settings-card vault-health-review" aria-label="Login health">
    <h3>Login health</h3>
    <p>Check for duplicate logins, missing websites, password reuse and short or repeated-character passwords. The check stays on this device.</p>
    <div className="credential-actions"><button type="button" disabled={busy} onClick={() => void review()}>
      {report ? 'Check again' : 'Check login health'}
    </button></div>
    {report && <p role="status">{report.findings.length ? `${loginCount(report.findings.length)} to review. ${report.checked} checked.`
      : `No issues found in ${loginCount(report.checked)}.`}</p>}
    {findings.length > 0 && <ul>
      {findings.slice(0, limit).map(({ id, issues }) => {
        const item = namedItems.get(id)!;
        return <li key={id}>
          <strong>{item.label}</strong>
          <p>{item.url ? domainFromUrl(item.url) : 'No website saved'} · {item.username}</p>
          <p>{issues.map((issue) => labels[issue]).join(' · ')}</p>
          <div className="credential-actions">
            <button type="button" disabled={busy} aria-label={'Edit ' + item.label}
              onClick={() => void review(() => window.privateBrowser.editVaultHealthLogin(accountId, id))}>Edit</button>
            <button type="button" disabled={busy} className="danger" aria-label={'Delete ' + item.label}
              onClick={() => void review(() => window.privateBrowser.requestVaultDelete(id))}>Delete</button>
          </div>
        </li>;
      })}
    </ul>}
    {findings.length > limit && <div className="credential-actions">
      <button type="button" onClick={() => setLimit((count) => count + RESULTS_PER_PAGE)}>Show more</button>
    </div>}
  </section>;
}
