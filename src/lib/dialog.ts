import { useEffect, useState, type RefObject } from 'react';

const FOCUSABLE = 'button:not([disabled]), select:not([disabled]), input:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

/**
 * Keyboard behaviour for a dialog that gates a decision: focus moves into it,
 * Tab and Shift+Tab stay inside it, Escape runs `onEscape`, and focus returns
 * to where it was when the dialog closes. Before, Tab walked out of the
 * permission prompt into the toolbar behind it (F-70).
 */
export function useModalFocus(ref: RefObject<HTMLElement>, onEscape?: () => void, initialSelector = FOCUSABLE): void {
  useEffect(() => {
    const container = ref.current;
    if (!container) return undefined;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    container.querySelector<HTMLElement>(initialSelector)?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && onEscape) {
        event.preventDefault();
        event.stopPropagation();
        onEscape();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = [...container.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((element) => element.offsetParent !== null || element === document.activeElement);
      if (!focusable.length) { event.preventDefault(); return; }
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && (document.activeElement === first || !container.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !container.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    };
    // Captured on the document so the app's global shortcuts never see a key
    // pressed while a decision is pending.
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      if (previous?.isConnected) previous.focus();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- set up once per dialog instance
  }, []);
}

/**
 * True once `delayMs` has passed since mount. A permission prompt appears
 * without warning, so a click already on its way — the second half of a
 * double-click a page asked for — must not land on "Always here" (F-64).
 */
export function useArmedAfter(delayMs: number): boolean {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setArmed(true), delayMs);
    return () => window.clearTimeout(timer);
  }, [delayMs]);
  return armed;
}
