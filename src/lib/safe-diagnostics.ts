const catalog = {
  'PB-SETUP-ACCOUNT-LOCKED': ['Setup', 'Unlock the current Account Space from Manage Account Spaces.'],
  'PB-SETUP-REVIEW': ['Setup', 'Open the relevant step in the Setup guide.'],
  'PB-RECOVERY-VERSION': ['Recovery', 'Open the backup location and use a compatible Private Browser version.'],
  'PB-RECOVERY-STATE': ['Recovery', 'Retry the read-only recovery screen.'],
  'PB-RECOVERY-MIGRATION': ['Recovery', 'Retry the migration from the recovery screen.'],
  'PB-RECOVERY-ACCOUNT': ['Recovery', 'Open the backup location before restoring the Account Space.'],
  'PB-RECOVERY-PAGE': ['Recovery', 'Reload the affected page or go back.'],
  'PB-RECOVERY-CERTIFICATE': ['Recovery', 'Check the address and the device clock before retrying.'],
  'PB-RECOVERY-STARTUP': ['Recovery', 'Restore selected tabs or start with a new tab.'],
  'PB-UPDATE-CHECK': ['Updates', 'Check again from App updates.'],
  'PB-UPDATE-RELEASE': ['Updates', 'Check for updates again before downloading.'],
  'PB-UPDATE-VERIFY': ['Updates', 'Download a fresh copy from App updates.'],
  'PB-UPDATE-SAVE': ['Updates', 'Check free disk space, then try again.'],
  'PB-UPDATE-OPEN': ['Updates', 'Open the verified download page or try again from App updates.'],
  'PB-SIDE-APP-OFFLINE': ['Side apps', 'Check the internet connection and select Retry.'],
  'PB-SIDE-APP-CERTIFICATE': ['Side apps', 'Check the device clock before retrying.'],
  'PB-SIDE-APP-REDIRECT': ['Side apps', 'Open the app in a regular tab if you trust the destination.'],
  'PB-SIDE-APP-LOAD': ['Side apps', 'Select Retry in the side panel.'],
  'PB-SIDE-APP-CHECK': ['Side apps', 'Complete the human check in the side panel.'],
  'PB-BRIDGE-VERSION': ['Developer Bridge', 'Install the bundled VS Code extension and pair again.'],
  'PB-BRIDGE-CONNECTION': ['Developer Bridge', 'Check that VS Code is open and pair again.'],
  'PB-BRIDGE-PROJECT': ['Developer Bridge', 'Choose and approve a trusted workspace folder in VS Code.'],
} as const;

export type DiagnosticReason = keyof typeof catalog;

export function formatSafeDiagnostics(reason: DiagnosticReason, version?: string): string {
  const [category, nextAction] = catalog[reason];
  const safeVersion = typeof version === 'string' && /^\d{1,10}(?:\.\d{1,10}){2}(?:-[\da-z.-]{1,40})?$/i.test(version)
    ? version : 'unavailable';
  return ['Private Browser ' + safeVersion, 'Category ' + category, 'Reason ' + reason, 'Next action ' + nextAction].join('\n');
}
