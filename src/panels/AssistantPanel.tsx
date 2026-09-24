import { FormEvent, useEffect, useState } from 'react';
import { Bot, Check, Cloud, Eye, LoaderCircle, LockKeyhole, ShieldCheck, Sparkles } from 'lucide-react';
import type { AiPagePreview, AiProviderInput, AiProviderStatus } from '../../electron/types';
import { PanelHeader } from './common';
import { domainFromUrl } from '../lib/format';

export function AssistantPanel({ onToast }: { onToast: (message: string, kind?: 'ok' | 'error') => void }) {
  const [preview, setPreview] = useState<AiPagePreview | null>(null);
  const [approvalToken, setApprovalToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [provider, setProvider] = useState<AiProviderStatus>({ configured: false });
  const [showProviderForm, setShowProviderForm] = useState(false);
  const [providerForm, setProviderForm] = useState<AiProviderInput>({ endpoint: 'https://openrouter.ai/api/v1', model: '', apiKey: '' });
  const [question, setQuestion] = useState('Summarize the important points on this page.');
  const [answer, setAnswer] = useState('');
  useEffect(() => { void window.privateBrowser.getAiProvider().then(setProvider).catch(() => undefined); }, []);
  const clearContext = async () => {
    setPreview(null);
    setApprovalToken(null);
    setAnswer('');
    // Forgetting the token in the renderer did not invalidate it: the captured
    // page text and the live capability stayed in the main process for the full
    // five minutes. Revoke it for real.
    try { await window.privateBrowser.revokeAiContext(); } catch { /* nothing to revoke */ }
  };
  // Leaving the panel is the same intent as pressing Clear.
  useEffect(() => () => { void window.privateBrowser.revokeAiContext().catch(() => undefined); }, []);
  const prepare = async () => {
    setLoading(true);
    setApprovalToken(null);
    setAnswer('');
    try { setPreview(await window.privateBrowser.prepareAiPreview()); }
    catch (error) { onToast(error instanceof Error ? error.message : String(error), 'error'); }
    finally { setLoading(false); }
  };
  const approve = async () => {
    if (!preview) return;
    setLoading(true);
    try {
      const approval = await window.privateBrowser.approveAiPreview(preview.id);
      setPreview(approval.preview);
      setApprovalToken(approval.token);
      onToast('Sanitized context approved');
    } catch (error) { onToast(error instanceof Error ? error.message : String(error), 'error'); }
    finally { setLoading(false); }
  };
  const configureProvider = async (event: FormEvent) => {
    event.preventDefault();
    setLoading(true);
    try {
      setProvider(await window.privateBrowser.configureAiProvider(providerForm));
      setShowProviderForm(false);
      onToast('AI provider encrypted and saved');
    } catch (error) { onToast(error instanceof Error ? error.message : String(error), 'error'); }
    finally {
      setLoading(false);
      // Clear the key whether or not it was accepted: a rejected submit used to
      // leave it in renderer state and in the input's DOM value.
      setProviderForm((value) => ({ ...value, apiKey: '' }));
    }
  };
  const ask = async () => {
    if (!approvalToken) return;
    setLoading(true);
    try {
      setAnswer(await window.privateBrowser.askAi(approvalToken, question));
      setApprovalToken(null);
    } catch (error) { onToast(error instanceof Error ? error.message : String(error), 'error'); }
    finally { setLoading(false); }
  };
  return (
    <div className="side-panel">
      <PanelHeader icon={Bot} eyebrow="Private assistant" title="Page intelligence" />
      <div className="local-banner"><LockKeyhole size={15} /><div><strong>Private by default</strong><span>Nothing leaves this device without approval.</span></div></div>
      <div className="provider-strip">
        <span className={provider.configured ? 'connected' : ''} />
        <div><strong>{provider.configured ? provider.model : provider.error === 'provider-corrupt' ? 'Provider recovery required' : 'Cloud AI not connected'}</strong><small>{provider.configured ? domainFromUrl(provider.endpoint ?? '') : provider.error === 'provider-corrupt' ? 'Reset the unreadable configuration' : 'Local tools remain available'}</small></div>
        <button onClick={() => { setShowProviderForm((value) => !value); setProviderForm((value) => ({ ...value, apiKey: '' })); }}>{provider.configured ? 'Change' : 'Connect'}</button>
      </div>
      {showProviderForm && <form className="vault-form provider-form" onSubmit={configureProvider}>
        <input placeholder="OpenAI-compatible endpoint" required value={providerForm.endpoint} onChange={(event) => setProviderForm({ ...providerForm, endpoint: event.target.value })} />
        <input placeholder="Model ID" required value={providerForm.model} onChange={(event) => setProviderForm({ ...providerForm, model: event.target.value })} />
        <input placeholder="API key (encrypted)" type="password" value={providerForm.apiKey} onChange={(event) => setProviderForm({ ...providerForm, apiKey: event.target.value })} />
        <button className="primary-button" type="submit" disabled={loading}><LockKeyhole size={15} /> Save encrypted provider</button>
        {(provider.configured || provider.error === 'provider-corrupt') && <button className="text-button danger-text" type="button" onClick={() => { if (window.confirm('Remove the saved AI provider configuration?')) void window.privateBrowser.clearAiProvider().then((status) => { setProvider(status); setShowProviderForm(false); onToast('AI provider removed'); }).catch((error) => onToast(error instanceof Error ? error.message : String(error), 'error')); }}>{provider.error === 'provider-corrupt' ? 'Reset provider configuration' : 'Remove provider'}</button>}
      </form>}
      {!preview ? (
        <div className="assistant-empty">
          <span className="orb"><Sparkles size={25} /></span>
          <h3>Understand this page</h3>
          <p>Read visible text locally, remove sensitive patterns, and review it before any cloud use.</p>
          <button className="primary-button" onClick={prepare} disabled={loading}>{loading ? <LoaderCircle className="spin" size={16} /> : <Eye size={16} />} Read page locally</button>
        </div>
      ) : (
        <>
          <div className="context-card">
            <div className="context-heading"><span>EXACTLY WHAT WOULD BE SENT</span><b>{preview.redactions} redacted</b></div>
            <h3>{preview.title || 'Untitled page'}</h3>
            <small className="context-origin">{preview.url}</small>
            {preview.text
              ? <><pre className="context-text">{preview.text}</pre><small className="context-size">{preview.text.length.toLocaleString()} characters — scroll the box to read all of it</small></>
              : <p>No readable text was found. Only the title and address above would be sent.</p>}
          </div>
          <div className="permission-card">
            <div><Cloud size={17} /><strong>Cloud permission</strong></div>
            <p>The title, address and text shown above are the whole of what leaves this machine. Nothing else from the page is sent, and only for the one request you approve.</p>
            {approvalToken ? <div className="approved"><Check size={15} /> Approved for one request</div> : <button className="primary-button" onClick={approve} disabled={loading || !provider.configured}><ShieldCheck size={16} /> {provider.configured ? 'Approve context' : 'Connect provider first'}</button>}
          </div>
          {approvalToken && <div className="ask-card"><textarea maxLength={2000} value={question} onChange={(event) => setQuestion(event.target.value)} /><button className="primary-button full" onClick={() => void ask()} disabled={loading || !question.trim()}>{loading ? <LoaderCircle className="spin" size={15} /> : <Sparkles size={15} />} Ask cloud AI once</button></div>}
          {answer && <div className="answer-card"><span>AI ANSWER</span><p>{answer}</p></div>}
          <button className="text-button" onClick={() => void clearContext()}>Clear page context</button>
        </>
      )}
    </div>
  );
}
