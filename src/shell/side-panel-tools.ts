import type { PinnablePanelTool } from '../../electron/types';

export const SIDE_PANEL_NAMES: Record<PinnablePanelTool, string> = {
  easynote: 'Notes',
  claude: 'Claude',
  assistant: 'AI assistant',
  developer: 'Developer Bridge',
  vault: 'MyVault',
  automations: 'Automations',
  downloads: 'Downloads',
  privacy: 'Privacy log',
};
