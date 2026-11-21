import { useEffect, useState } from 'react';
import type { AccountSpaceSummary, GoogleConnectionHealth, GoogleHealthState } from '../../electron/types';

const label: Record<GoogleHealthState, string> = {
  unavailable: 'Connection health unavailable',
  disconnected: 'Google tools are disconnected',
  ready: 'Google tools are connected',
  reconnect: 'Reconnect needed',
  permission: 'Permission needed',
  offline: 'Google could not be reached',
  quota: 'Google quota delay',
};

const localDate = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export function GoogleHealthCard({ account }: { account: AccountSpaceSummary }) {
  const [health, setHealth] = useState<GoogleConnectionHealth>();
  useEffect(() => {
    let generation = 0;
    let current = true;
    const refresh = () => {
      const request = ++generation;
      void window.privateBrowser.getGoogleConnectionHealth(account.id).then((value) => {
        if (current && request === generation) setHealth(value);
      }).catch(() => {
        if (current && request === generation) setHealth({ state: 'unavailable' });
      });
    };
    refresh();
    const unsubscribe = window.privateBrowser.onGoogleOperationProgress((progress) => {
      if (progress.accountSpaceId === account.id && (progress.phase === 'completed' || progress.phase === 'failed')) refresh();
    });
    return () => { current = false; unsubscribe(); };
  }, [account.id, account.googleConnection, account.locked]);
  const next = health?.state === 'reconnect' ? 'Reconnect with the selected access below.'
    : health?.state === 'permission' ? 'Select the Google tool you need below and reconnect to review access.'
      : health?.state === 'offline' ? 'Restore your connection, then retry the Google action.'
        : health?.state === 'quota' ? health.retryAt ? 'Try again after ' + localDate.format(new Date(health.retryAt)) + '.' : 'Wait a few minutes, then retry.'
          : health?.state === 'disconnected' ? 'Connect in an external browser when you need a Google tool.' : undefined;
  return <div className="google-health-card" role="status">
    <strong>{account.googleConnection === 'connecting' ? 'Connecting…' : health ? label[health.state] : 'Checking Google connection…'}</strong>
    <small>Selected Account Space · {account.label}</small>
    {health && health.state !== 'unavailable' && <small>{health.lastSuccessAt
      ? <>Last successful Google request <time dateTime={health.lastSuccessAt}>{localDate.format(new Date(health.lastSuccessAt))}</time></>
      : 'No successful Google request recorded.'}</small>}
    {next && <p>{next}</p>}
  </div>;
}
