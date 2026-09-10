/// <reference types="vite/client" />

import type { PrivateBrowserApi } from '../electron/preload.cjs';

declare global {
  interface Window {
    privateBrowser: PrivateBrowserApi;
  }
}
