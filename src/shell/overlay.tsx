import { createContext, useContext, useEffect } from 'react';

/**
 * Anything the chrome draws over the page area — a menu, a dialog, a resize
 * drag — must hide the native page view first, because a `WebContentsView`
 * always paints above the React tree. Each such layer acquires the overlay;
 * the App freezes the page into a still image, hides the live view, and
 * reports `ready` once the menu can be shown without being cut off.
 */
export interface OverlayController {
  acquire: () => () => void;
  ready: boolean;
}

export const OverlayContext = createContext<OverlayController>({ acquire: () => () => undefined, ready: true });

export function useOverlayLayer(active = true): boolean {
  const overlay = useContext(OverlayContext);
  useEffect(() => (active ? overlay.acquire() : undefined), [active, overlay.acquire]);
  return overlay.ready || !active;
}
