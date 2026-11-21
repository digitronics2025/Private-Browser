export const AI_SYSTEM_PROMPT = 'Answer only from the user-approved webpage context. Clearly say when the context is insufficient. Never request or expose credentials.';

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
