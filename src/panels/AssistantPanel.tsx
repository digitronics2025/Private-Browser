import { FormEvent, useEffect, useState } from 'react';
import { Bot, Cloud, Eye, LoaderCircle, LockKeyhole, ShieldCheck, Sparkles } from 'lucide-react';
import type { AccountSpaceId, AiPagePreview, AiPreviewScope, AiProviderCheckResult, AiProviderCheckState, AiRequestReview, AssistantAnswer, AssistantReceipt, AssistantSelectionSource, AssistantSpacePolicy, BrowserTab, CloudAiProviderInput, AiProviderStatus, LocalAiModels, WorkspaceId } from '../../electron/types';
import { ASSISTANT_PRESETS, assistantContextLimit, MAX_ASSISTANT_EXTRA_SOURCES, MAX_ASSISTANT_QUESTION, type AssistantPresetId, type AssistantPresetOverrides } from '../../electron/ai-prompt';
import { AssistantMarkdown } from '../lib/AssistantMarkdown';
import { PanelHeader } from './common';
import { domainFromUrl } from '../lib/format';

const sentences = new Intl.Segmenter(undefined, { granularity: 'sentence' });
const checkMessages: Record<AiProviderCheckState, string> = {
  ready: 'The selected model answered the built-in sample.',
  'not-configured': 'Save a provider before testing.',
  authentication: 'The provider refused access. Check the API key and access to this model.',
  'bad-request': 'The provider rejected the request.',
  'insufficient-credit': 'Check provider credit or billing.',
  'context-too-long': 'Reduce the approved context.',
  'model-not-found': 'Check the model ID and endpoint.',
  model: 'Check the provider endpoint and model ID.',
  'rate-limit': 'The provider is limiting requests. Try again later.',
  'invalid-response': 'The provider returned an empty or unreadable response.',
  unavailable: 'Could not reach the AI provider. Check the connection and endpoint.',
  'local-setup': 'Start Ollama with cloud features disabled and check that the selected model is installed.',
};
const providerEndpoints = { Anthropic: 'https://api.anthropic.com/v1', OpenRouter: 'https://openrouter.ai/api/v1', OpenAI: 'https://api.openai.com/v1' };
const receiptPurpose: Record<AssistantReceipt['purpose'], string> = {
  'page-request': 'Page request',
  'connection-test': 'Connection test',
  'developer-request': 'Developer request',
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

export function AssistantPanel({ accountId, workspace, policy, presets, tabs, onToast }: {
  accountId: AccountSpaceId;
  workspace: WorkspaceId;
  policy: AssistantSpacePolicy;
  presets?: AssistantPresetOverrides;
  tabs: Pick<BrowserTab, 'id' | 'title'>[];
  onToast: (message: string, kind?: 'ok' | 'error') => void;
}) {
  const [preview, setPreview] = useState<AiPagePreview | null>(null);
  const [review, setReview] = useState<AiRequestReview | null>(null);
  const [contextText, setContextText] = useState('');
  const [extraSources, setExtraSources] = useState<AssistantSelectionSource[]>([]);
  const [sourceTab, setSourceTab] = useState('');
  const unusedTabs = tabs.filter((tab) => !extraSources.some((source) => source.tabId === tab.id));
  const contextCount = contextText.length + extraSources.reduce((total, source) => total + source.text.length, 0);
  const [loading, setLoading] = useState(false);
  const [requestInFlight, setRequestInFlight] = useState<Pick<AiRequestReview, 'id' | 'mode'> | null>(null);
  const [provider, setProvider] = useState<AiProviderStatus>({ configured: false });
  const [showProviderForm, setShowProviderForm] = useState(false);
  const [providerCheck, setProviderCheck] = useState<AiProviderCheckResult>();
  const [providerForm, setProviderForm] = useState<CloudAiProviderInput>({ endpoint: 'https://openrouter.ai/api/v1', model: '', apiKey: '' });
  const [presetProvider, setPresetProvider] = useState("OpenRouter");
  const [providerMode, setProviderMode] = useState<'local' | 'cloud'>('local');
  const [local, setLocal] = useState<LocalAiModels>();
  const [localModel, setLocalModel] = useState('');
  const contextLimit = assistantContextLimit(provider.mode);
  const isLocal = provider.mode === 'local';
  const cloudBlocked = provider.mode === 'cloud' && policy.cloud !== 'allowed';
  const [question, setQuestion] = useState('Summarize the important points on this page.');
  const [preset, setPreset] = useState<AssistantPresetId | ''>('');
  const [withEvidence, setWithEvidence] = useState(false);
  const [answer, setAnswer] = useState<AssistantAnswer | null>(null);
  const copyableAnswer = answer?.kind === 'answer' ? answer.text : answer?.kind === 'sources' ? answer.items.map(({ claim }) => claim).join('\n') : '';
  const [passageQuery, setPassageQuery] = useState('');
  const [passages, setPassages] = useState<string[]>();
  useEffect(() => { void window.privateBrowser.getAiProvider().then(setProvider).catch(() => undefined); }, []);
  useEffect(() => { setProviderCheck(undefined); }, [provider.mode, provider.model, provider.endpoint]);
  const clearContext = async () => {
    setPreview(null);
    setReview(null);
    setContextText('');
    setExtraSources([]);
    setAnswer(null);
    setPassageQuery('');
    setPassages(undefined);
    // Forgetting the token in the renderer did not invalidate it: the captured
    // page text and the live capability stayed in the main process for the full
    // five minutes. Revoke it for real.
    try { await window.privateBrowser.revokeAiContext(); } catch { /* nothing to revoke */ }
  };
  // Leaving the panel is the same intent as pressing Clear.
  useEffect(() => () => { void window.privateBrowser.revokeAiContext().catch(() => undefined); }, []);
  const prepare = async (scope: AiPreviewScope) => {
    setLoading(true);
    setReview(null);
    setExtraSources([]);
    setAnswer(null);
    setPassageQuery('');
    setPassages(undefined);
    try {
      const captured = await window.privateBrowser.prepareAiPreview(scope);
      setPreview(captured);
      setContextText(captured.text);
    }
    catch (error) { onToast(error instanceof Error ? error.message : String(error), 'error'); }
    finally { setLoading(false); }
  };
  const reviewRequest = async () => {
    if (!preview) return;
    setLoading(true);
    try {
      setReview(await window.privateBrowser.reviewAssistantRequest(preview.id, contextText, question, withEvidence, extraSources.map(({ id, text }) => ({ id, text }))));
    } catch (error) { onToast(error instanceof Error ? error.message : String(error), 'error'); }
    finally { setLoading(false); }
  };
  const addSource = async () => {
    if (!preview || !sourceTab) return;
    setLoading(true);
    try {
      const source = await window.privateBrowser.prepareAssistantSource(preview.id, sourceTab);
      setExtraSources((current) => [...current, source]);
      setSourceTab('');
      setReview(null);
    } catch (error) {
      onToast(error instanceof Error ? error.message : 'Could not read the selected source.', 'error');
    } finally {
      setLoading(false);
    }
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
    try { setProviderCheck(await window.privateBrowser.checkAiProvider()); }
    catch { setProviderCheck({ state: 'unavailable' }); }
    finally { setLoading(false); }
  };
  const changeCloudPolicy = async (allowed: boolean) => {
    setLoading(true);
    try {
      await window.privateBrowser.setAssistantCloudAllowed(accountId, allowed);
      await clearContext();
      setProviderCheck(undefined);
    } catch (error) {
      onToast(error instanceof Error ? error.message : 'Could not change cloud AI settings.', 'error');
    } finally {
      setLoading(false);
    }
  };
  const ask = async () => {
    if (!review) return;
    setLoading(true);
    setRequestInFlight(review);
    setReview(null);
    setAnswer(null);
    try {
      const result = await window.privateBrowser.sendReviewedAssistant(review.id);
      if (result.kind !== 'timeout' && result.kind !== 'cancelled') {
        setQuestion('');
      }
      setAnswer(result);
    } catch (error) {
      onToast(error instanceof Error ? error.message : String(error), 'error');
    } finally { setRequestInFlight(null); setLoading(false); }
  };
  const savePreset = async (id: AssistantPresetId, changes: AssistantPresetOverrides, message: string) => {
    setLoading(true);
    try {
      await window.privateBrowser.setBrowserSettings({ assistantPrompts: changes }, workspace);
      setQuestion(changes[id] ?? ASSISTANT_PRESETS[id].question);
      setReview(null);
      onToast(message);
    } catch (error) {
      onToast(error instanceof Error ? error.message : 'Could not save the prompt preset.', 'error');
    } finally {
      setLoading(false);
    }
  };
  return (
    <div className="side-panel">
      <PanelHeader icon={Bot} eyebrow="Private assistant" title="Page intelligence" />
      <div className="local-banner"><LockKeyhole size={15} /><div><strong>Private by default</strong><span>Nothing leaves this device without approval.</span></div></div>
      <div className="assistant-space-policy settings-card">
        <label><input type="checkbox" checked={policy.cloud === 'allowed'} disabled={loading || policy.cloud === 'unavailable'} onChange={(event) => void changeCloudPolicy(event.target.checked)} /> Allow cloud AI in this Account Space</label>
        {policy.cloud === 'disabled' && <small>Cloud requests are blocked here. A local model can still be used.</small>}
        <details>
          <summary>Recent Assistant requests</summary>
          {policy.receipts.length ? <ul>{policy.receipts.map((receipt, index) => <li key={`${receipt.at}-${index}`}>
            <strong>{receiptPurpose[receipt.purpose]}</strong>
            <span>{receipt.destination}</span>
            <time dateTime={receipt.at}>{new Date(receipt.at).toLocaleString()}</time>
          </li>)}</ul> : <p>No requests recorded in this Account Space.</p>}
        </details>
      </div>
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
        <button className="text-button" type="button" disabled={loading || cloudBlocked} onClick={() => void checkConnection()}>Test connection</button>
        <small>Uses a built-in sample.</small>
        {providerCheck && <p role="status">{checkMessages[providerCheck.state]} {providerCheck.reason}</p>}
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
          <label>Provider<select value={presetProvider} onChange={(event) => {
            const name = event.target.value;
            setPresetProvider(name);
            if (name in providerEndpoints) setProviderForm({ endpoint: providerEndpoints[name as keyof typeof providerEndpoints], model: name === 'Anthropic' ? 'claude-sonnet-5-5' : '', apiKey: '' });
          }}>{[...Object.keys(providerEndpoints), 'Custom'].map(name => <option key={name}>{name}</option>)}</select></label>
          {presetProvider === 'Anthropic' && <datalist id="assistant-models">{['claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-opus-5-5'].map(model => <option key={model} value={model} />)}</datalist>}
          <input placeholder="OpenAI-compatible endpoint" required value={providerForm.endpoint} onChange={(event) => { setPresetProvider('Custom'); setProviderForm({ ...providerForm, endpoint: event.target.value, apiKey: '' }); }} />
          <input placeholder="Model ID" list="assistant-models" required maxLength={200} pattern="[^\s]+" title="Enter the model ID without spaces"
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
          <button className="primary-button" onClick={() => void prepare('selection')} disabled={loading}><Eye size={16} /> Read selection locally</button>
          <button className="text-button" onClick={() => void prepare('page')} disabled={loading}>{loading ? <LoaderCircle className="spin" size={16} /> : null} Read page locally</button>
        </div>
      ) : (
        <>
          <div className="context-card">
            <div className="context-heading"><span>PAGE CONTEXT</span><b>{preview.redactions} redacted</b></div>
            <h3>{preview.title || 'Untitled page'}</h3>
            <small className="context-origin">{preview.url}</small>
            <label>Page text<textarea aria-label="Page text" className="context-text" value={contextText} maxLength={contextLimit} disabled={loading} onChange={(event) => {
              setContextText(event.target.value);
              setReview(null);
            }} /></label>
            <small className="context-size">{contextText.length.toLocaleString()} of {contextLimit.toLocaleString()} page characters</small>
            {extraSources.length > 0 && <button type="button" className="text-button" disabled={loading} onClick={() => {
              setContextText(contextText.trim() ? '' : preview.text);
              setReview(null);
            }}>{contextText.trim() ? 'Remove current excerpt' : 'Restore current excerpt'}</button>}
          </div>
          {extraSources.map((source) => <div className="context-card" key={source.id}>
            <h3>{source.title}</h3>
            <small className="context-origin">{source.url}</small>
            <label>Excerpt from {source.title}<textarea className="context-text" value={source.text} maxLength={contextLimit / 3} disabled={loading} onChange={(event) => {
              const updated = event.target.value;
              setExtraSources((current) => current.map((item) => item.id === source.id ? { ...item, text: updated } : item));
              setReview(null);
            }} /></label>
            <button type="button" className="text-button" aria-label={`Remove source ${source.title}`} disabled={loading} onClick={() => {
              setExtraSources((current) => current.filter((item) => item.id !== source.id));
              setReview(null);
            }}>Remove source</button>
          </div>)}
          {unusedTabs.length > 0 && extraSources.length < MAX_ASSISTANT_EXTRA_SOURCES && <details className="context-card assistant-source-picker">
            <summary>Add a source from another tab</summary>
            <p>Select text in the other tab before coming here to add it.</p>
            <label>Source tab<select aria-label="Source tab" value={sourceTab} disabled={loading} onChange={(event) => setSourceTab(event.target.value)}>
              <option value="">Choose a tab</option>
              {unusedTabs.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
            </select></label>
            <button type="button" className="secondary-button" disabled={loading || !sourceTab} onClick={() => void addSource()}>Add selected text</button>
          </details>}
          {extraSources.length > 0 && <small className="context-size">{contextCount.toLocaleString()} of {contextLimit.toLocaleString()} characters across excerpts</small>}
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
          <form className="ask-card" onSubmit={(event) => { event.preventDefault(); void reviewRequest(); }}>
            <label>Prompt preset<select aria-label="Prompt preset" value={preset} disabled={loading} onChange={(event) => {
              const id = event.target.value as AssistantPresetId | '';
              setPreset(id);
              if (id) setQuestion(presets?.[id] ?? ASSISTANT_PRESETS[id].question);
              setWithEvidence(id === 'specs' || id === 'comparison');
              setReview(null);
            }}>
              <option value="">Custom question</option>
              {Object.entries(ASSISTANT_PRESETS).map(([id, value]) => <option key={id} value={id}>{value.label}</option>)}
            </select></label>
            <label>{answer && answer.kind !== 'cancelled' && answer.kind !== 'timeout' ? 'Ask a follow-up' : 'Question'}<textarea maxLength={MAX_ASSISTANT_QUESTION} value={question} disabled={loading} onChange={(event) => { setQuestion(event.target.value); setReview(null); }} /></label>
            <small className="context-size">{question.length.toLocaleString()} of {MAX_ASSISTANT_QUESTION.toLocaleString()} question characters</small>
            {preset && <div className="panel-actions preset-actions">
              <button type="button" disabled={loading || !question.trim() || question.trim() === (presets?.[preset] ?? ASSISTANT_PRESETS[preset].question)} onClick={() => void savePreset(preset, { ...presets, [preset]: question.trim() }, 'Prompt preset saved')}>Save preset</button>
              {presets?.[preset] && <button type="button" disabled={loading} onClick={() => {
                const changes = { ...presets };
                delete changes[preset];
                void savePreset(preset, changes, 'Default prompt restored');
              }}>Restore default</button>}
            </div>}
            <label className="evidence-option"><input type="checkbox" checked={withEvidence} disabled={loading} onChange={(event) => {
              setWithEvidence(event.target.checked);
              setReview(null);
            }} /> Include source passages</label>
            <button className="primary-button full" type="submit" disabled={loading || !provider.configured || cloudBlocked || !question.trim() || contextCount > contextLimit}><ShieldCheck size={16} /> {cloudBlocked ? 'Cloud AI is disabled here' : provider.configured ? answer?.kind === 'timeout' ? 'Review retry' : 'Review request' : 'Connect provider first'}</button>
          </form>
          {review && <section className="permission-card request-review" aria-label="Request review">
            <div>{review.mode === 'local' ? <LockKeyhole size={17} /> : <Cloud size={17} />}<strong>{review.mode === 'local' ? 'Send to local model' : 'Send to cloud provider'}</strong></div>
            <p>{review.destination}</p><p>{review.model} · {review.redactions} redacted</p>
            <details><summary>System instruction</summary><pre className="context-text">{review.systemPrompt}</pre></details>
            <pre className="context-text">{review.userPrompt}</pre>
            {review.mode === 'cloud' && <RequestCostEstimate review={review} />}
            <button className="primary-button full" type="button" onClick={() => void ask()} disabled={loading}>Approve and ask once</button>
          </section>}
          {requestInFlight && <div className="permission-card">
            <p role="status">{requestInFlight.mode === 'local' ? 'Waiting for the local model…' : 'Waiting for the cloud provider…'}</p>
            <button type="button" className="text-button" onClick={() => {
              void window.privateBrowser.cancelReviewedAssistant(requestInFlight.id).catch((error) => onToast(error instanceof Error ? error.message : 'Could not cancel the request.', 'error'));
            }}>Cancel request</button>
          </div>}
          <button className="text-button" onClick={() => void clearContext()} disabled={loading}>Clear page context</button>
        </>
      )}
      {answer && <div className="answer-card">
        {(answer.kind === 'answer' || answer.kind === 'sources') && <span>AI ANSWER</span>}
        {answer.kind === 'answer' && <AssistantMarkdown text={answer.text} onOpen={url => void window.privateBrowser.newTab(workspace, url, accountId).catch(() => onToast('Could not open link.', 'error'))} />}
        {answer.kind === 'insufficient' && <p role="status">Insufficient page information. The reply included no source passage from the approved text.</p>}
        {answer.kind === 'cancelled' && <p role="status">Request cancelled.</p>}
        {answer.kind === 'timeout' && <p role="status">The provider timed out. Review the request before retrying.</p>}
        {answer.kind === 'sources' && <ul className="source-findings">{answer.items.map(({ claim, quote }) => <li key={claim}>
          <p>{claim}</p><blockquote aria-label="Source passage">{quote}</blockquote>
        </li>)}</ul>}
        {answer.truncated && <p role="status">Answer was cut off — ask a narrower question.</p>}
        {answer.usage && <p>{answer.usage.promptTokens} input tokens · {answer.usage.completionTokens} output tokens</p>}
        {copyableAnswer && <button type="button" className="text-button" onClick={() => {
          void window.privateBrowser.copyText(copyableAnswer).then(() => onToast('Answer copied')).catch((error) => onToast(error instanceof Error ? error.message : 'Could not copy the answer.', 'error'));
        }}>Copy answer</button>}
      </div>}
    </div>
  );
}

function RequestCostEstimate({ review }: { review: AiRequestReview }) {
  const [inputRate, setInputRate] = useState('');
  const [outputRate, setOutputRate] = useState('');
  const [outputTokens, setOutputTokens] = useState('256');
  const inputBytes = new TextEncoder().encode(review.systemPrompt + review.userPrompt).byteLength;
  const estimatedInputTokens = Math.ceil(inputBytes / 4);
  const estimate = (estimatedInputTokens * Number(inputRate) + Number(outputTokens) * Number(outputRate)) / 1_000_000;
  const hasEstimate = [inputRate, outputRate, outputTokens].every((value) => value.trim() && Number.isFinite(Number(value)) && Number(value) >= 0);

  return <details className="request-cost">
    <summary>Estimate cost locally</summary>
    <p>Enter your provider’s prices per million tokens in USD. This estimate uses prompt size and your expected answer length.</p>
    <label>Input price per million<input type="number" min={0} step="any" inputMode="decimal" value={inputRate} onChange={(event) => setInputRate(event.target.value)} /></label>
    <label>Output price per million<input type="number" min={0} step="any" inputMode="decimal" value={outputRate} onChange={(event) => setOutputRate(event.target.value)} /></label>
    <label>Estimated output tokens<input type="number" min={0} step={1} inputMode="numeric" value={outputTokens} onChange={(event) => setOutputTokens(event.target.value)} /></label>
    {hasEstimate && Number.isFinite(estimate) && <p role="status">Estimated cost: {new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 6 }).format(estimate)}</p>}
  </details>;
}
