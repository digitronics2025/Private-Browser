import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { useOverlayLayer } from './overlay';

export interface PromptField {
  name: string;
  label: string;
  value: string;
  type?: 'text' | 'url';
  maxLength?: number;
  placeholder?: string;
}

export interface PromptRequest {
  title: string;
  description?: string;
  confirmLabel: string;
  fields: PromptField[];
  submit: (values: Record<string, string>) => Promise<unknown> | unknown;
}

/** Electron has no `window.prompt`, so text input for renames and shortcuts uses this trusted dialog. */
export function PromptDialog({ request, onDone }: { request: PromptRequest; onDone: () => void }) {
  useOverlayLayer();
  const titleId = useId();
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(request.fields.map((field) => [field.name, field.value])));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    const input = formRef.current?.querySelector('input');
    input?.focus();
    input?.select();
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (request.fields.some((field) => !values[field.name]?.trim())) {
      setError('Fill in every field.');
      return;
    }
    setBusy(true);
    try {
      await request.submit(values);
      onDone();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop prompt-backdrop" role="presentation" onPointerDown={(event) => { if (event.target === event.currentTarget) onDone(); }}>
      <form
        ref={formRef}
        className="prompt-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onSubmit={submit}
        onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); onDone(); } }}
      >
        <h2 id={titleId}>{request.title}</h2>
        {request.description && <p>{request.description}</p>}
        {request.fields.map((field) => (
          <label key={field.name}>
            <span>{field.label}</span>
            <input
              type={field.type === 'url' ? 'text' : 'text'}
              inputMode={field.type === 'url' ? 'url' : undefined}
              value={values[field.name] ?? ''}
              maxLength={field.maxLength}
              placeholder={field.placeholder}
              spellCheck={field.type !== 'url'}
              onChange={(event) => setValues((current) => ({ ...current, [field.name]: event.target.value }))}
            />
          </label>
        ))}
        {error && <p className="prompt-error" role="alert">{error}</p>}
        <div className="dialog-actions">
          <button type="button" className="secondary-button" onClick={onDone}>Cancel</button>
          <button type="submit" className="primary-button" disabled={busy}>{request.confirmLabel}</button>
        </div>
      </form>
    </div>
  );
}
