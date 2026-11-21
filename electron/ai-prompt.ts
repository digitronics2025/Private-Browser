export const AI_SYSTEM_PROMPT = 'Answer only from the user-approved webpage context. Clearly say when the context is insufficient. Never request or expose credentials.';
export const MAX_ASSISTANT_CONTEXT = 12000;
export const MAX_ASSISTANT_QUESTION = 2000;

export const ASSISTANT_PRESETS = {
  darija: { label: 'Short Darija reply', question: 'Write a short, polite reply in Moroccan Darija using Arabic script. Keep the facts and commitments in the selected text.' },
  french: { label: 'French rewrite', question: 'Rewrite the selected text in clear, natural French. Keep the meaning and important details.' },
  specs: { label: 'Product specifications', question: 'Extract the product name, model and stated specifications from the selected text. Mark anything missing as unavailable.' },
  comparison: { label: 'Product comparison', question: 'Compare the products mentioned in the selected text. List only supported differences and identify missing information.' },
} as const;

export type AssistantPresetId = keyof typeof ASSISTANT_PRESETS;
export type AssistantPresetOverrides = Partial<Record<AssistantPresetId, string>>;

export function aiUserPrompt(context: { title: string; url: string; text: string; dom?: string }, question: string): string {
  const structure = context.dom ? `\n\nApproved structural DOM (no text or values):\n${context.dom}` : '';
  return `Page: ${context.title}\nURL: ${context.url}\n\nApproved context:\n${context.text}${structure}\n\nQuestion: ${question}`;
}
import type { AssistantAnswer } from './types.js';


export function assistantQuestion(question: string, withEvidence: boolean): string {
  if (!withEvidence) return question;
  return `${question}\n\nUse this JSON format: {"findings":[{"claim":"A concise fact","quote":"An exact short quote from the approved context"}]}. Include one quote per finding. If the context is insufficient, return {"findings":[]}.`;
}

export function readAssistantAnswer(value: string, evidence: boolean, context: string): AssistantAnswer {
  if (!evidence) return { kind: 'answer', text: value };
  let findings: unknown;
  try {
    const unwrapped = value.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i, '$1');
    findings = (JSON.parse(unwrapped) as { findings?: unknown } | null)?.findings;
  } catch {
    return { kind: 'insufficient' };
  }
  if (!Array.isArray(findings)) return { kind: 'insufficient' };
  const items: { claim: string; quote: string }[] = [];
  const seen = new Set<string>();
  for (const finding of findings.slice(0, 8)) {
    if (!finding || typeof finding.claim !== 'string' || typeof finding.quote !== 'string') continue;
    const claim = finding.claim.trim();
    const quote = finding.quote.trim();
    if (!claim || claim.length > 1000 || quote.length < 8 || quote.length > 380 || !context.includes(quote) || seen.has(claim)) continue;
    items.push({ claim, quote });
    seen.add(claim);
  }
  return items.length ? { kind: 'sources', items } : { kind: 'insufficient' };
}
