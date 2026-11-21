import type { AgentActionClass, AgentSpaceSettings, ClientLimits } from '@private-browser/bridge-protocol/agent-permissions';

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
  spaceId?: string;
  actionClass?: AgentActionClass;
  origin?: string;
  decision: 'allowed' | 'denied' | 'failed';
  result: string;
}

export interface AgentUiStatus {
  enabled: boolean;
  unavailable?: string;
  pairing?: { code: string; expiresAt: number };
  clients: { id: string; name: string; limits: ClientLimits; active: boolean; expiresAt?: number }[];
  spaces: (AgentSpaceSettings & { id: string; uploadRootPresent: boolean; migrated: boolean })[];
  possibleSignIn?: string;
  tabs: { id: string; name: string; client: string; space: string; manual: boolean; canManual: boolean; label?: string }[];
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
