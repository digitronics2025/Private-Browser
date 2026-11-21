import { useCallback, useEffect, useRef, useState } from 'react';
import type { DevServerStatus } from '@private-browser/bridge-protocol';

const phaseLabels: Record<DevServerStatus['phase'], string> = {
  stopped: 'Stopped',
  waiting: 'Waiting for the development server',
  ready: 'Ready for local connections',
  stopping: 'Stopping',
  failed: 'Could not start',
  'missing-command': 'No development command found',
};

const reasonLabels: Record<NonNullable<DevServerStatus['reason']>, string> = {
  'port-in-use': 'The expected port is already in use. Free it or configure the project to use a different port.',
  'command-ended': 'The development command ended. Check its VS Code terminal before retrying.',
  'missing-executable': 'VS Code could not find the command. Install the project dependencies and check the terminal.',
  'address-not-reported': 'Waiting for the project command to print its local address.',
  'not-listening': 'The reported port is still closed. Check the VS Code terminal if startup stalls.',
};

export function DevelopmentServer({ projectName }: { projectName: string }) {
  const [status, setStatus] = useState<DevServerStatus>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const generation = useRef(0);

  const read = useCallback(async (refresh = false) => {
    const request = ++generation.current;
    try {
      const result = await window.privateBrowser.runBridgeAction('server.status', { refresh }) as DevServerStatus;
      if (generation.current !== request) return;
      setStatus(result);
      setError('');
    } catch (reason) {
      if (generation.current === request) setError(reason instanceof Error ? reason.message : 'Could not check the development server.');
    }
  }, []);

  useEffect(() => {
    void read();
    return () => { generation.current += 1; };
  }, [read]);

  useEffect(() => {
    if (busy || (status?.phase !== 'waiting' && status?.phase !== 'ready')) return;
    const timer = window.setInterval(() => void read(), 5000);
    return () => window.clearInterval(timer);
  }, [busy, read, status?.phase]);

  const change = async (action: 'server.start' | 'server.stop' | 'server.restart') => {
    const request = ++generation.current;
    setBusy(true);
    setError('');
    try {
      const result = await window.privateBrowser.runBridgeAction(action);
      if (generation.current !== request) return;
      if (action === 'server.stop') await read();
      else setStatus(result as DevServerStatus);
    } catch (reason) {
      if (generation.current === request) setError(reason instanceof Error ? reason.message : 'Could not change the development server.');
    } finally {
      setBusy(false);
    }
  };

  const canStop = status?.phase === 'ready' || status?.phase === 'waiting';
  return <section className="development-server" aria-labelledby="development-server-heading" aria-busy={busy}>
    <h3 id="development-server-heading">Development server</h3>
    <p>{projectName}</p>
    <p role="status">{status ? phaseLabels[status.phase] : 'Checking the selected project…'}</p>
    <dl>
      <div><dt>Expected URL</dt><dd>{status?.expectedUrl ?? 'Set by the project command'}</dd></div>
      <div><dt>Listening port</dt><dd>{status?.port ?? 'Awaiting verification'}</dd></div>
      {status?.address && <div><dt>Detected address</dt><dd>{status.address}</dd></div>}
    </dl>
    {status?.phase === 'missing-command' && <p>Add a dev, start or serve script to the project’s package.json, then check again.</p>}
    {status?.reason && <p>{reasonLabels[status.reason]}</p>}
    {error && <p role="alert">{error}</p>}
    <div className="bridge-action-row">
      {!canStop && <button type="button" className="primary-button" disabled={busy || !status || status.phase === 'missing-command' || status.phase === 'stopping'} onClick={() => void change('server.start')}>{status?.phase === 'failed' ? 'Retry' : 'Start server'}</button>}
      {canStop && <button type="button" className="secondary-button" disabled={busy} onClick={() => void change('server.stop')}>Stop server</button>}
      {canStop && <button type="button" className="secondary-button" disabled={busy} onClick={() => void change('server.restart')}>{status?.reason ? 'Retry' : 'Restart'}</button>}
      <button type="button" className="secondary-button" disabled={busy} onClick={() => void read(true)}>Check server status</button>
      {status?.phase === 'ready' && status.address && <button type="button" className="secondary-button" disabled={busy} onClick={() => {
        void window.privateBrowser.newTab('development', status.address).catch(() => setError('Could not open the local server.'));
      }}>Open local server</button>}
    </div>
  </section>;
}
