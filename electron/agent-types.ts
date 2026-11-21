import type { AgentPolicy } from './agent-policy.js';

export type AgentDecision = 'allow' | 'session' | 'deny';

export interface AgentConfirmationCard {
  id: string;
  client: string;
  tab: string;
  origin: string;
  action: string;
  target?: string;
  input?: string;
  formTarget?: string;
  expiresAt: number;
  canAllowSession: boolean;
}

export interface AgentAuditRow {
  at: string;
  client: string;
  tool: string;
  origin?: string;
  decision: 'allowed' | 'denied' | 'failed';
  result: string;
}

export interface AgentUiStatus {
  enabled: boolean;
  unavailable?: string;
  pairing?: { code: string; expiresAt: number };
  clients: { id: string; name: string; policy: AgentPolicy; active: boolean; uploadFolder?: string }[];
  spaces: { id: string; name: string }[];
  tabs: { id: string; name: string; client: string; space: string; manual: boolean; label?: string }[];
  selectedTab?: string;
  current?: { client: string; step: string; tabId: string };
  active: boolean;
  lent?: { tabId: string; client: string; origin: string; expiresAt: number };
  paused: boolean;
  pending?: AgentConfirmationCard;
  audit: AgentAuditRow[];
  command: string;
  commandArgs: string[];
}
