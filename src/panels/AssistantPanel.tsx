import { FormEvent, useEffect, useState } from 'react';
import { Bot, Check, Cloud, Eye, LoaderCircle, LockKeyhole, ShieldCheck, Sparkles } from 'lucide-react';
import type { AiPagePreview, AiProviderCheckState, CloudAiProviderInput, AiProviderStatus, LocalAiModels } from '../../electron/types';
import { PanelHeader } from './common';
import { domainFromUrl } from '../lib/format';

const sentences = new Intl.Segmenter(undefined, { granularity: 'sentence' });
const checkMessages: Record<AiProviderCheckState, string> = {
  ready: 'The selected model answered the built-in sample.',
  'not-configured': 'Save a provider before testing.',
  authentication: 'The provider refused access. Check the API key and access to this model.',
  model: 'Check the provider endpoint and model ID.',
  'rate-limit': 'The provider is limiting requests. Try again later.',
  'invalid-response': 'The provider returned an empty or unreadable response.',
  unavailable: 'Could not reach the AI provider. Check the connection and endpoint.',
  'local-setup': 'Start Ollama with cloud features disabled and check that the selected model is installed.',
};

function searchWords(text: string): string[] {
  return text.normalize('NFKD').toLowerCase().replace(/\p{M}/gu, '').match(/[\p{L}\p{N}]+/gu) ?? [];
}

function findPagePassages(text: string, query: string): string[] {
  const keywords = new Set(searchWords(query));
  if (!keywords.size) return [];
  return [...sentences.segment(text)].map(({ segment }) => {
    const words = new Set(searchWords(segment));
    const score = [...keywords].filter((keyword) => words.has(keyword)).length;
    return { text: segment.trim(), score };
  }).filter(({ score }) => score > 0).sort((left, right) => right.score - left.score)
    .slice(0, 3).map((passage) => passage.text);
}

export function AssistantPanel({ onToast }: { onToast: (message: string, kind?: 'ok' | 'error') => void }) {
  const [preview, setPreview] = useState<AiPagePreview | null>(null);
  const [approvalToken, setApprovalToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [provider, setProvider] = useState<AiProviderStatus>({ configured: false });
  const [showProviderForm, setShowProviderForm] = useState(false);
  const [providerCheck, setProviderCheck] = useState<AiProviderCheckState>();
  const [providerForm, setProviderForm] = useState<CloudAiProviderInput>({ endpoint: 'https://openrouter.ai/api/v1', model: '', apiKey: '' });
  const [providerMode, setProviderMode] = useState<'local' | 'cloud'>('local');
  const [local, setLocal] = useState<LocalAiModels>();
  const [localModel, setLocalModel] = useState('');
  const isLocal = provider.mode === 'local';
  const [question, setQuestion] = useState('Summarize the important points on this page.');
  const [answer, setAnswer] = useState('');
  const [passageQuery, setPassageQuery] = useState('');
  const [passages, setPassages] = useState<string[]>();
  useEffect(() => { void window.privateBrowser.getAiProvider().then(setProvider).catch(() => undefined); }, []);
  useEffect(() => { setProviderCheck(undefined); }, [provider.mode, provider.model, provider.endpoint]);
  const clearContext = async () => {
    setPreview(null);
    setApprovalToken(null);
    setAnswer('');
    setPassageQuery('');
    setPassages(undefined);
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
    setPassageQuery('');
    setPassages(undefined);
    try { setPreview(await window.privateBrowser.prepareAiPreview()); }
    catch (error) { onToast(error instanceof Error ? error.message : String(error), 'error'); }
    finally { setLoading(false); }
  };
  const approve = async () => {
    if (!preview) return;
    setLoading(true);
    try {
      const approval = await window.privateBrowser.approveAiPreview(preview.id, isLocal ? 'local' : 'cloud');
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
      setProvider(await window.privateBrowser.configureAiProvider(providerMode === 'local' ? { mode: 'local', model: localModel } : providerForm));
      await clearContext();
      setShowProviderForm(false);
      onToast(providerMode === 'local' ? 'Local model saved' : 'AI provider encrypted and saved');
    } catch (error) { onToast(error instanceof Error ? error.message : String(error), 'error'); }
    finally {
      setLoading(false);
      // Clear the key whether or not it was accepted: a rejected submit used to
      // leave it in renderer state and in the input's DOM value.
      setProviderForm((value) => ({ ...value, apiKey: '' }));
    }
  };
  const checkLocal = async () => {
    setLoading(true);
    try {
      const result = await window.privateBrowser.getLocalAiModels();
      setLocal(result);
      setLocalModel((model) => result.models.includes(model) ? model : result.models[0] ?? '');
    } catch (error) { onToast(error instanceof Error ? error.message : String(error), 'error'); }
    finally { setLoading(false); }
  };
  const checkConnection = async () => {
    setLoading(true);
    setProviderCheck(undefined);
    try { setProviderCheck((await window.privateBrowser.checkAiProvider()).state); }
    catch { setProviderCheck('unavailable'); }
    finally { setLoading(false); }
  };
  const ask = async () => {
    if (!approvalToken) return;
    setLoading(true);
    try {
      setAnswer(await window.privateBrowser.askAi(approvalToken, question));
    } catch (error) {
      setPreview(null);
      onToast(error instanceof Error ? error.message : String(error), 'error');
    } finally { setApprovalToken(null); setLoading(false); }
  };
  return (
    <div className="side-panel">
      <PanelHeader icon={Bot} eyebrow="Private assistant" title="Page intelligence" />
      <div className="local-banner"><LockKeyhole size={15} /><div><strong>Private by default</strong><span>Nothing leaves this device without approval.</span></div></div>
      <div className="provider-strip">
        <span className={provider.configured ? 'connected' : ''} />
        <div><strong>{provider.configured ? provider.model : provider.error === 'provider-corrupt' ? 'Provider recovery required' : 'AI provider not connected'}</strong><small>{provider.configured ? isLocal ? 'Local · Ollama' : domainFromUrl(provider.endpoint ?? '') : provider.error === 'provider-corrupt' ? 'Reset the unreadable configuration' : 'Choose an installed local model or a cloud provider'}</small></div>
        <button disabled={loading} onClick={() => {
          setShowProviderForm((value) => !value);
          setProviderMode(provider.mode ?? 'local');
          setProviderForm((value) => ({ ...value, apiKey: '' }));
        }}>{provider.configured ? 'Change' : 'Connect'}</button>
      </div>
      {provider.configured && <div className="provider-check">
        <button className="text-button" type="button" disabled={loading} onClick={() => void checkConnection()}>Test connection</button>
        <small>Uses a built-in sample.</small>
        {providerCheck && <p role="status">{checkMessages[providerCheck]}</p>}
      </div>}
      {showProviderForm && <form className="vault-form provider-form" onSubmit={configureProvider}>
        <label>Provider type<select value={providerMode} onChange={(event) => {
          setProviderMode(event.target.value as 'local' | 'cloud');
          setProviderForm((value) => ({ ...value, apiKey: '' }));
        }}><option value="local">Local with Ollama</option><option value="cloud">Cloud</option></select></label>
        {providerMode === 'local' ? <>
          <button className="text-button" type="button" disabled={loading} onClick={() => void checkLocal()}>Check installed models</button>
          {local && <p role="status">{local.state === 'cloud-enabled'
            ? 'Turn off Ollama cloud features, restart Ollama and check again.'
            : local.state === 'unavailable' ? 'Start a version of Ollama that reports local-only status on this device.'
              : local.models.length ? 'Ollama is running with cloud features disabled.' : 'No installed local chat models found.'}</p>}
          {local?.models.length ? <label>Local model<select value={localModel} onChange={(event) => setLocalModel(event.target.value)}>
            {local.models.map((model) => <option key={model} value={model}>{model}</option>)}
          </select></label> : null}
        </> : <>
          <input placeholder="OpenAI-compatible endpoint" required value={providerForm.endpoint} onChange={(event) => setProviderForm({ ...providerForm, endpoint: event.target.value })} />
          <input placeholder="Model ID" required maxLength={200} pattern="[^\s]+" title="Enter the model ID without spaces"
            value={providerForm.model} onChange={(event) => setProviderForm({ ...providerForm, model: event.target.value })} />
          <input placeholder="API key (encrypted)" type="password" value={providerForm.apiKey} onChange={(event) => setProviderForm({ ...providerForm, apiKey: event.target.value })} />
        </>}
        <button className="primary-button" type="submit" disabled={loading || (providerMode === 'local' && !localModel)}>
          <LockKeyhole size={15} />{providerMode === 'local' ? 'Save local model' : 'Save encrypted provider'}
        </button>
        {(provider.configured || provider.error === 'provider-corrupt') && <button className="text-button danger-text" type="button" disabled={loading} onClick={() => { if (window.confirm('Remove the saved AI provider configuration?')) void window.privateBrowser.clearAiProvider().then(async (status) => { setProvider(status); await clearContext(); setShowProviderForm(false); onToast('AI provider removed'); }).catch((error) => onToast(error instanceof Error ? error.message : String(error), 'error')); }}>{provider.error === 'provider-corrupt' ? 'Reset provider configuration' : 'Remove provider'}</button>}
      </form>}
      {!preview ? (
        <div className="assistant-empty">
          <span className="orb"><Sparkles size={25} /></span>
          <h3>Understand this page</h3>
          <p>Read visible text locally, remove sensitive patterns, and review it before using a model.</p>
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
          {preview.text && <form className="ask-card" onSubmit={(event) => {
            event.preventDefault();
            setPassages(findPagePassages(preview.text, passageQuery));
          }}>
            <label>Page keywords <input maxLength={120} value={passageQuery} onChange={(event) => {
              setPassageQuery(event.target.value);
              setPassages(undefined);
            }} /></label>
            <button className="text-button" type="submit" disabled={!passageQuery.trim()}>Find passages locally</button>
            {passages && <div role="status" className="answer-card">
              {passages.length ? <ul>{passages.map((passage, index) => <li key={index}>{passage}</li>)}</ul>
                : <p>No matching passages in this page preview.</p>}
            </div>}
          </form>}
          <div className="permission-card">
            <div>{isLocal ? <LockKeyhole size={17} /> : <Cloud size={17} />}<strong>{isLocal ? 'Local model permission' : 'Cloud permission'}</strong></div>
            <p>{isLocal ? 'One approved request goes to Ollama on this device. Cloud features must be disabled.' : 'The title, address and text shown above are the whole of what leaves this machine. Nothing else from the page is sent, and only for the one request you approve.'}</p>
            {approvalToken ? <div className="approved"><Check size={15} /> Approved for one request</div> : <button className="primary-button" onClick={approve} disabled={loading || !provider.configured}><ShieldCheck size={16} /> {provider.configured ? 'Approve context' : 'Connect provider first'}</button>}
          </div>
          {approvalToken && <div className="ask-card"><textarea aria-label="Question" maxLength={2000} value={question} onChange={(event) => setQuestion(event.target.value)} /><button className="primary-button full" onClick={() => void ask()} disabled={loading || !question.trim()}>{loading ? <LoaderCircle className="spin" size={15} /> : <Sparkles size={15} />} {isLocal ? 'Ask local AI once' : 'Ask cloud AI once'}</button></div>}
          {answer && <div className="answer-card"><span>AI ANSWER</span><p>{answer}</p></div>}
          <button className="text-button" onClick={() => void clearContext()}>Clear page context</button>
        </>
      )}
    </div>
  );
}
