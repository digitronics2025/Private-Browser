import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { AccountSpaceSummary, GmailReplyDraft, GoogleActionReceipt, GoogleMutationConfirmation, GoogleOperationResult } from '../../electron/types';
import type { CalendarWriteInput, GmailSendInput } from '../../electron/google-services';

export type GoogleDraftSource =
  | { kind: 'gmail'; id: string; title: string }
  | { kind: 'drive'; id: string; title: string }
  | { kind: 'calendar' };

type Review = {
  confirmation: GoogleMutationConfirmation;
  changes: readonly [label: string, value: string][];
  submit: () => Promise<GoogleOperationResult>;
};

const draftNames = { gmail: 'Draft a reply', drive: 'Share a Drive file', calendar: 'Schedule a meeting' };
const actionNames = { gmail: 'Send reply', drive: 'Grant access and notify', calendar: 'Create event and invite' };

export function GoogleActionComposer({ account, source, onClose }: { account: AccountSpaceSummary; source: GoogleDraftSource; onClose: () => void }) {
  const [reply, setReply] = useState<GmailReplyDraft>();
  const [recipient, setRecipient] = useState('');
  const [role, setRole] = useState<'reader' | 'writer'>('reader');
  const [summary, setSummary] = useState('');
  const [text, setText] = useState('');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [createMeet, setCreateMeet] = useState(false);
  const [review, setReview] = useState<Review>();
  const [receipt, setReceipt] = useState<GoogleActionReceipt>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const working = useRef(false);
  const container = useRef<HTMLElement>(null);
  const name = draftNames[source.kind];

  useEffect(() => { container.current?.focus(); }, [source]);

  useEffect(() => {
    if (source.kind !== 'gmail') return;
    const operation = crypto.randomUUID();
    let current = true;
    void window.privateBrowser.readGmailReplyDraft(account.id, operation, source.id).then((result) => {
      if (!current) return;
      if (!result.ok || !result.data) throw new Error(result.error?.message ?? 'The original message could not be read.');
      setReply(result.data);
    }).catch((reason: unknown) => {
      if (current) setError(reason instanceof Error ? reason.message : 'The original message could not be read.');
    });
    return () => { current = false; void window.privateBrowser.cancelOperation(operation).catch(() => undefined); };
  }, [account.id, source]);

  const run = async (task: () => Promise<void>) => {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setError('');
    try { await task(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'This Google action is unavailable.'); }
    finally { working.current = false; setBusy(false); }
  };

  const prepare = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      const api = window.privateBrowser;
      const id = account.id;
      if (source.kind === 'gmail') {
        if (!reply || !text.trim()) throw new Error('Enter the reply text.');
        const { sourceRevision } = reply;
        const input: GmailSendInput = { to: [reply.recipient], subject: reply.subject, body: text };
        const confirmation = await api.prepareGmailSend(id, input, sourceRevision);
        setReview({ confirmation, changes: [['To', reply.recipient], ['Subject', reply.subject], ['Message', text]],
          submit: () => api.sendGmail(id, crypto.randomUUID(), input, confirmation.token, sourceRevision) });
      } else if (source.kind === 'drive') {
        const email = recipient.trim();
        const confirmation = await api.prepareDriveShare(id, source.id, email, role);
        setReview({ confirmation, changes: [['File', source.title], ['File ID', source.id], ['Recipient', email], ['Access', role === 'reader' ? 'Viewer' : 'Editor'], ['Notification', 'Google emails the recipient']],
          submit: () => api.shareDriveFile(id, crypto.randomUUID(), source.id, email, role, confirmation.token) });
      } else {
        const starts = new Date(start);
        const ends = new Date(end);
        if (!summary.trim() || !Number.isFinite(starts.getTime()) || !Number.isFinite(ends.getTime()) || ends <= starts) {
          throw new Error('Give the meeting a title and an end time after its start.');
        }
        const guests = recipient.split(',').map((email) => email.trim()).filter(Boolean);
        const input: CalendarWriteInput = { summary: summary.trim(), description: text, start: starts.toISOString(), end: ends.toISOString(), attendees: guests, createMeet };
        const pretty = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'long' });
        const confirmation = await api.prepareCalendarWrite(id, 'create', input);
        setReview({ confirmation, changes: [['Calendar', 'Primary'], ['Title', input.summary], ['Starts', pretty.format(starts)], ['Ends', pretty.format(ends)],
          ['Invitees', guests.length ? guests.join(', ') : 'None'], ['Description', text || 'None'], ['Google Meet', createMeet ? 'Add a meeting link' : 'Off']],
          submit: () => api.writeCalendarEvent(id, crypto.randomUUID(), 'create', input, confirmation.token) });
      }
    });
  };

  const confirm = () => {
    if (!review) return;
    void run(async () => {
      const pending = review;
      setReview(undefined);
      if (Date.parse(pending.confirmation.expiresAt) <= Date.now()) throw new Error('This review expired. Review the action again.');
      const result = await pending.submit();
      if (result.receipt) setReceipt(result.receipt);
      if (!result.ok && !result.receipt) throw new Error(result.error?.message ?? 'Google did not accept the action.');
      if (result.ok && !result.receipt) throw new Error('Check the original Google app for the action result.');
    });
  };

  return <section ref={container} tabIndex={-1} className="google-action-composer" aria-label={name} aria-busy={busy}>
    <h4>{name}</h4>
    <p>Google account <strong>{account.email ?? account.label}</strong></p>
    {error && <p role="alert">{error}</p>}
    {receipt ? <div role="status">
      <strong>{receipt.state === 'confirmed' ? 'Google confirmed this action' : 'Result unconfirmed'}</strong>
      <p>Receipt <code>{receipt.id}</code></p>
      <p><time dateTime={receipt.at}>{new Date(receipt.at).toLocaleString()}</time></p>
      {receipt.providerId && <p>Google reference <code>{receipt.providerId}</code></p>}
      {receipt.state !== 'confirmed' && <p>Check the original Google app for the result before taking the action there.</p>}
    </div> : review ? <>
      <h5>Review before applying</h5>
      <dl>{review.changes.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
      <div className="google-overview-actions"><button type="button" className="secondary-button" onClick={() => setReview(undefined)}>Edit draft</button>
        <button type="button" className="primary-button" disabled={busy} onClick={confirm}>{actionNames[source.kind]}</button></div>
    </> : <form onSubmit={prepare}>
      {source.kind === 'gmail' ? reply ? <>
        <p>To <strong>{reply.recipient}</strong></p><p>{reply.subject}</p>
        <label>Reply<textarea required maxLength={16_384} value={text} onChange={(event) => setText(event.currentTarget.value)} /></label>
      </> : !error && <p role="status">Reading the original message headers…</p> : source.kind === 'drive' ? <>
        <p>{source.title}</p>
        <label>Recipient email<input required type="email" maxLength={320} value={recipient} onChange={(event) => setRecipient(event.currentTarget.value)} /></label>
        <label>Access<select value={role} onChange={(event) => setRole(event.currentTarget.value === 'writer' ? 'writer' : 'reader')}><option value="reader">Viewer</option><option value="writer">Editor</option></select></label>
      </> : <>
        <label>Meeting title<input required maxLength={300} value={summary} onChange={(event) => setSummary(event.currentTarget.value)} /></label>
        <label>Starts<input required type="datetime-local" value={start} onChange={(event) => setStart(event.currentTarget.value)} /></label>
        <label>Ends<input required type="datetime-local" value={end} onChange={(event) => setEnd(event.currentTarget.value)} /></label>
        <label>Invitees<input type="email" multiple maxLength={500} value={recipient} onChange={(event) => setRecipient(event.currentTarget.value)} /></label>
        <label>Details<textarea maxLength={4_096} value={text} onChange={(event) => setText(event.currentTarget.value)} /></label>
        <label className="google-action-meet"><input type="checkbox" checked={createMeet} onChange={(event) => setCreateMeet(event.currentTarget.checked)} /> Add Google Meet</label>
      </>}
      {(source.kind !== 'gmail' || reply) && <button className="secondary-button" type="submit" disabled={busy}>Review action</button>}
    </form>}
    <button type="button" className="secondary-button" disabled={busy} onClick={onClose}>{receipt ? 'Close receipt' : 'Close draft'}</button>
  </section>;
}
