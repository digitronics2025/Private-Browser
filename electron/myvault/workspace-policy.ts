import type { WorkspaceId } from '../types.js';

export interface VaultWorkspacePolicy {
  vaultSurface: boolean;
  manualFill: boolean;
  automaticFill: boolean;
  /** Chrome-style account list drawn by the trusted overlay under a focused login field. */
  fillPicker: boolean;
  saveCapture: boolean;
  passwordClipboard: boolean;
  requireFillConfirmation: boolean;
  aiExtraction: boolean;
  devTools: boolean;
  extensions: boolean;
  passkeys: boolean;
}

const STANDARD: VaultWorkspacePolicy = {
  vaultSurface: true, manualFill: true, automaticFill: true, fillPicker: true, saveCapture: true, passwordClipboard: true,
  requireFillConfirmation: false, aiExtraction: true, devTools: false, extensions: true, passkeys: false,
};

export function workspaceVaultPolicy(workspaceId: WorkspaceId): VaultWorkspacePolicy {
  if (workspaceId === 'banking') return {
    vaultSurface: true, manualFill: true, automaticFill: false, fillPicker: false, saveCapture: false, passwordClipboard: false,
    requireFillConfirmation: true, aiExtraction: false, devTools: false, extensions: false, passkeys: false,
  };
  if (workspaceId === 'development') return {
    vaultSurface: false, manualFill: false, automaticFill: false, fillPicker: false, saveCapture: false, passwordClipboard: false,
    requireFillConfirmation: false, aiExtraction: true, devTools: true, extensions: false, passkeys: false,
  };
  return { ...STANDARD };
}
