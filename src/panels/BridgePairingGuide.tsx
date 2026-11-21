import { useEffect, useState } from 'react';
import type { BridgeStatus } from '../../electron/types';

export function BridgePairingGuide({ bridge, busy, onInstall, onPair, onCancel, onCheck }: {
  bridge: BridgeStatus;
  busy: boolean;
  onInstall: () => void;
  onPair: () => void;
  onCancel: () => void;
  onCheck: () => void;
}) {
  const [now, setNow] = useState(Date.now);
  const [lastExpiry, setLastExpiry] = useState<number>();
  const expiry = bridge.pairingExpiresAt;
  const connected = bridge.state === 'connected';
  const pairing = bridge.state === 'pairing' && expiry !== undefined && expiry > now;
  const expired = (bridge.state === 'disconnected' && bridge.activity !== 'Pairing cancelled'
    && lastExpiry !== undefined && lastExpiry <= now) || (bridge.state === 'pairing' && !pairing);

  useEffect(() => {
    setNow(Date.now());
    if (!expiry) return;
    setLastExpiry(expiry);
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [expiry]);

  return <section className="bridge-pairing-guide" aria-labelledby="bridge-pairing-heading">
    <h3 id="bridge-pairing-heading">{connected ? 'Connection details' : 'Set up the VS Code companion'}</h3>
    {connected ? <dl>
      <div><dt>Extension</dt><dd>{bridge.extensionVersion ?? 'Connected'} · Protocol matched</dd></div>
      <div><dt>VS Code window</dt><dd>{bridge.vscodeVersion ?? 'Local editor'} {bridge.instanceId && <code>{bridge.instanceId.slice(0, 8)}</code>}</dd></div>
      <div><dt>Workspace trust</dt><dd>{bridge.project ? bridge.project.project.trusted ? 'Trusted in VS Code' : 'Restricted in VS Code' : 'Select a workspace below'}</dd></div>
      <div><dt>Project access</dt><dd>{bridge.project ? bridge.project.project.name + ' · Approved' : 'Waiting for approval in VS Code'}</dd></div>
    </dl> : <ol>
      <li><strong>Install the companion</strong><p>Use the extension bundled with this browser.</p>
        <button type="button" className="secondary-button" disabled={busy} onClick={onInstall}>Install VS Code extension</button>
      </li>
      <li><strong>Pair the intended VS Code window</strong>
        <p>In VS Code, open the Command Palette and choose <b>Private Browser: Pair with Browser</b>.</p>
        {pairing && <div className="bridge-pairing-code">
          <code aria-label="Pairing code">{bridge.pairingCode}</code>
          <p>Valid until <time dateTime={new Date(expiry).toISOString()}>{new Date(expiry).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })}</time></p>
        </div>}
        {expired && <p role="status">Pairing code expired. Generate a new code to continue.</p>}
        {pairing ? <button type="button" className="secondary-button" disabled={busy} onClick={onCancel}>Cancel pairing</button>
          : <button type="button" className="primary-button" disabled={busy} onClick={onPair}>{expired ? 'Generate new pairing code' : 'Generate pairing code'}</button>}
      </li>
      <li><strong>Approve a project</strong><p>Trust the folder in VS Code, then choose it here and review the access request in VS Code.</p></li>
    </ol>}
    {bridge.state === 'incompatible' && <p role="alert">The protocol versions differ. Install the bundled extension and reload VS Code.</p>}
    <button type="button" className="secondary-button" disabled={busy} onClick={onCheck}>Check connection status</button>
  </section>;
}
