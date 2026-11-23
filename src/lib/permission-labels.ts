import type { PermissionCapability, PermissionGrantDuration } from '../../electron/types';

export const permissionLabels: Record<PermissionCapability, string> = {
  notifications: 'Notifications',
  microphone: 'Microphone',
  camera: 'Camera',
  'camera-and-microphone': 'Camera and microphone',
  'display-capture': 'Screen sharing',
  geolocation: 'Location',
  'clipboard-read': 'Read clipboard',
  'clipboard-write': 'Write to clipboard',
  'file-system': 'File access',
  download: 'Downloads',
  popups: 'Pop-ups',
};

export const permissionDuration: Record<PermissionGrantDuration, string> = {
  once: 'Once',
  session: 'This session',
  'until-revoked': 'Until revoked',
};
