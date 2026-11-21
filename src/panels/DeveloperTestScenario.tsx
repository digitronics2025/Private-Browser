import { useEffect, useState } from 'react';
import type { TestViewport } from '@private-browser/bridge-protocol';

const viewports: ReadonlyArray<{ name: string; id: TestViewport }> = [
  { name: 'Desktop', id: 'desktop' }, { name: 'Tablet', id: 'tablet' }, { name: 'Mobile', id: 'mobile' },
];

function localOrigin(value?: string): URL | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (['http:', 'https:'].includes(url.protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      && !url.username && !url.password) return url;
  } catch { /* The project URL is unavailable. */ }
  return undefined;
}

export function DeveloperTestScenario({ projectId, projectUrl, activeUrl, disabled, run }: {
  projectId: string;
  projectUrl?: string;
  activeUrl: string;
  disabled: boolean;
  run: (data: { kind: 'current-page' | 'baseline' | 'baseline-compare'; url: string; viewports: TestViewport[]; fixture?: string }) => void;
}) {
  const active = localOrigin(activeUrl);
  const base = localOrigin(projectUrl) ?? active;
  const [route, setRoute] = useState(() => active?.origin === base?.origin ? active?.pathname ?? '/' : '/');
  const [fixtures, setFixtures] = useState<string[]>([]);
  const [fixture, setFixture] = useState('');
  const [selected, setSelected] = useState<TestViewport[]>(['desktop']);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let current = true;
    setError('');
    void window.privateBrowser.runBridgeAction('test.configuration', {}).then((value) => {
      if (current) {
        const choices = (value as { fixtures: string[] }).fixtures;
        setFixtures(choices);
        setFixture((selected) => choices.includes(selected) ? selected : '');
      }
    }, (reason: unknown) => {
      if (current) setError(reason instanceof Error ? reason.message : 'Could not list the project fixtures.');
    });
    return () => { current = false; };
  }, [projectId, revision]);
  const candidate = base && /^\/(?!\/)[^?#\\\u0000-\u001f]{0,1000}$/.test(route) ? new URL(route, base.origin) : undefined;
  const target = candidate?.pathname === route ? candidate : undefined;
  const send = (kind: 'current-page' | 'baseline' | 'baseline-compare') => {
    if (target && target.origin === base?.origin && selected.length) run({ kind, url: target.href,
      viewports: selected, ...(fixture ? { fixture } : {}) });
  };
  return <fieldset className="developer-scenario" disabled={disabled}>
    <legend>Local test scenario</legend>
    <label className="bridge-label">Route<input value={route} placeholder="/catalogue" onChange={(event) => setRoute(event.target.value)} /></label>
    {base ? <p>Local server <code>{base.origin}</code></p> : <p>Start the project server or open its local page.</p>}
    {route && base && !target && <p role="status">Enter a route beginning with / and use the fixture for the test data.</p>}
    <label className="bridge-label">Data fixture<select value={fixture} onChange={(event) => setFixture(event.target.value)}>
      <option value="">Live local data</option>
      {fixtures.map((name) => <option key={name} value={name}>{name}</option>)}
    </select></label>
    {error && <p role="alert">{error}</p>}
    <button type="button" onClick={() => setRevision((value) => value + 1)}>Refresh fixtures</button>
    <div className="bridge-action-row" role="group" aria-label="Viewports">
      {viewports.map(({ name, id }) => <label key={id} className="bridge-check"><input type="checkbox" checked={selected.includes(id)}
        onChange={(event) => setSelected((current) => event.target.checked ? [...current, id] : current.filter((item) => item !== id))} />{name}</label>)}
    </div>
    <div className="bridge-action-row">
      <button type="button" disabled={!target || !selected.length} onClick={() => send('current-page')}>Run scenario</button>
      <button type="button" disabled={!target || !selected.length} onClick={() => send('baseline')}>Save local baseline</button>
      <button type="button" disabled={!target || !selected.length} onClick={() => send('baseline-compare')}>Compare with baseline</button>
    </div>
  </fieldset>;
}
