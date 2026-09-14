import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronRight, type LucideIcon } from 'lucide-react';
import { useOverlayLayer } from './overlay';

type Placement = 'bottom-start' | 'bottom-end' | 'right-start';

interface MenuTree { closeAll: () => void }
const MenuTreeContext = createContext<MenuTree | null>(null);

interface SurfaceState { openSubmenu: string | null; setOpenSubmenu: (id: string | null, byKeyboard?: boolean) => void; openedByKeyboard: boolean }
const SurfaceContext = createContext<SurfaceState>({ openSubmenu: null, setOpenSubmenu: () => undefined, openedByKeyboard: false });

const ITEM_SELECTOR = '[role="menuitem"],[role="menuitemradio"],[role="menuitemcheckbox"]';
const MARGIN = 8;

export interface MenuSurfaceProps {
  label: string;
  onClose: () => void;
  children: ReactNode;
  anchor?: HTMLElement | null;
  point?: { x: number; y: number };
  placement?: Placement;
  role?: 'menu' | 'dialog';
  className?: string;
  autoFocus?: boolean;
}

/**
 * A Windows 11-style popup: portalled to the body so no toolbar can clip it,
 * clamped to the viewport, keyboard navigable, closed by Escape, outside click
 * or window blur, and restoring focus to whatever opened it.
 */
export function MenuSurface({ label, onClose, children, anchor, point, placement = 'bottom-start', role = 'menu', className = '', autoFocus = true }: MenuSurfaceProps) {
  const parentTree = useContext(MenuTreeContext);
  const nested = Boolean(parentTree);
  const ready = useOverlayLayer(!nested);
  const ref = useRef<HTMLDivElement>(null);
  const restoreFocus = useRef(autoFocus);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const [position, setPosition] = useState<CSSProperties | null>(null);
  const [openSubmenu, setOpenSubmenuState] = useState<string | null>(null);
  const [openedByKeyboard, setOpenedByKeyboard] = useState(false);

  const close = (restore: boolean) => {
    restoreFocus.current = restore;
    onCloseRef.current();
  };
  const tree = useMemo<MenuTree>(() => parentTree ?? { closeAll: () => close(true) }, [parentTree]);
  const surface = useMemo<SurfaceState>(() => ({
    openSubmenu,
    openedByKeyboard,
    setOpenSubmenu: (id, byKeyboard = false) => { setOpenedByKeyboard(byKeyboard); setOpenSubmenuState(id); },
  }), [openSubmenu, openedByKeyboard]);

  useLayoutEffect(() => {
    const place = () => {
      const element = ref.current;
      if (!element) return;
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      const width = element.offsetWidth;
      const height = Math.min(element.scrollHeight, viewportHeight - MARGIN * 2);
      const rect = anchor?.getBoundingClientRect();
      let left = MARGIN;
      let top = MARGIN;
      if (point) {
        left = point.x + width > viewportWidth - MARGIN ? point.x - width : point.x;
        top = point.y + height > viewportHeight - MARGIN ? point.y - height : point.y;
      } else if (rect && placement === 'right-start') {
        left = rect.right - 2 + width > viewportWidth - MARGIN ? rect.left - width + 2 : rect.right - 2;
        top = rect.top - 6;
      } else if (rect) {
        left = placement === 'bottom-end' ? rect.right - width : rect.left;
        top = rect.bottom + 4;
      }
      left = Math.max(MARGIN, Math.min(left, viewportWidth - width - MARGIN));
      // A menu that drops from a toolbar button stays below it and scrolls when the
      // window is short; pushing it upward would cover the tabs and the native
      // Windows caption buttons.
      top = rect && !point && placement !== 'right-start'
        ? Math.min(top, Math.max(rect.bottom + 4, viewportHeight - height - MARGIN))
        : Math.max(MARGIN, Math.min(top, viewportHeight - height - MARGIN));
      setPosition({ left, top, maxHeight: viewportHeight - top - MARGIN });
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [anchor, point?.x, point?.y, placement]);

  // Focus only once the surface has been positioned: a `visibility: hidden`
  // element cannot take focus, and without focus Escape and arrows do nothing.
  const focused = useRef(false);
  useEffect(() => {
    if (!autoFocus || !position || focused.current) return;
    focused.current = true;
    const element = ref.current;
    const first = element?.querySelector<HTMLElement>('input:not([disabled])')
      ?? [...(element?.querySelectorAll<HTMLElement>(ITEM_SELECTOR) ?? [])].find((item) => item.closest('.menu-surface') === element && !item.hasAttribute('disabled'))
      ?? element;
    first?.focus({ preventScroll: true });
  }, [position]);

  useEffect(() => () => {
    if (restoreFocus.current && anchor?.isConnected) anchor.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    if (nested) return;
    const onPointer = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest('.menu-surface')) return;
      if (target instanceof Node && anchor?.contains(target)) return;
      close(false);
    };
    const onBlur = () => close(false);
    // Escape closes the menu even when focus has wandered outside it.
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      close(true);
    };
    document.addEventListener('pointerdown', onPointer, true);
    window.addEventListener('blur', onBlur);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer, true);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('keydown', onKey);
    };
  }, [nested, anchor]);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const element = ref.current;
    if (!element) return;
    const items = [...element.querySelectorAll<HTMLElement>(ITEM_SELECTOR)]
      .filter((item) => item.closest('.menu-surface') === element && !item.hasAttribute('disabled'));
    const index = items.indexOf(document.activeElement as HTMLElement);
    const inInput = (event.target as HTMLElement).tagName === 'INPUT';
    const focusAt = (next: number) => {
      event.preventDefault();
      event.stopPropagation();
      items[(next + items.length) % items.length]?.focus();
    };
    switch (event.key) {
      case 'Escape':
        event.preventDefault();
        event.stopPropagation();
        close(true);
        return;
      case 'ArrowDown': focusAt(index + 1); return;
      case 'ArrowUp': focusAt(index < 0 ? -1 : index - 1); return;
      case 'Home': if (!inInput) focusAt(0); return;
      case 'End': if (!inInput) focusAt(-1); return;
      case 'ArrowLeft':
        if (nested && !inInput) { event.preventDefault(); event.stopPropagation(); close(true); }
        return;
      case 'Tab':
        if (role === 'menu') { event.preventDefault(); tree.closeAll(); }
        return;
      default:
    }
  };

  return createPortal(
    <MenuTreeContext.Provider value={tree}>
      <SurfaceContext.Provider value={surface}>
        <div
          ref={ref}
          role={role}
          aria-label={label}
          className={`menu-surface ${className} ${ready && position ? 'ready' : ''}`}
          style={position ?? { left: 0, top: 0, visibility: 'hidden' }}
          tabIndex={-1}
          onKeyDown={onKeyDown}
        >
          {children}
        </div>
      </SurfaceContext.Provider>
    </MenuTreeContext.Provider>,
    document.body,
  );
}

export interface MenuItemProps {
  label: ReactNode;
  onSelect?: () => void;
  icon?: LucideIcon;
  leading?: ReactNode;
  trailing?: ReactNode;
  hint?: ReactNode;
  shortcut?: string;
  ariaLabel?: string;
  title?: string;
  disabled?: boolean;
  danger?: boolean;
  keepOpen?: boolean;
  role?: 'menuitem' | 'menuitemradio' | 'menuitemcheckbox';
  checked?: boolean;
  className?: string;
}

export function MenuItem({ label, onSelect, icon: Icon, leading, trailing, hint, shortcut, ariaLabel, title, disabled, danger, keepOpen, role = 'menuitem', checked, className = '' }: MenuItemProps) {
  const tree = useContext(MenuTreeContext);
  const surface = useContext(SurfaceContext);
  const selectable = role !== 'menuitem';
  return (
    <button
      type="button"
      role={role}
      aria-checked={selectable ? Boolean(checked) : undefined}
      aria-label={ariaLabel}
      title={title}
      disabled={disabled}
      className={`menu-item ${danger ? 'danger' : ''} ${className}`}
      onMouseEnter={() => surface.setOpenSubmenu(null)}
      onClick={() => {
        onSelect?.();
        if (!keepOpen) tree?.closeAll();
      }}
    >
      <span className="menu-item-icon" aria-hidden="true">{leading ?? (Icon ? <Icon size={16} /> : selectable && checked ? <Check size={16} /> : null)}</span>
      <span className="menu-item-label">{label}{hint ? <small>{hint}</small> : null}</span>
      {trailing}
      {shortcut && <kbd>{shortcut}</kbd>}
    </button>
  );
}

export function SubmenuItem({ id, label, icon: Icon, children, disabled }: { id: string; label: string; icon?: LucideIcon; children: ReactNode; disabled?: boolean }) {
  const surface = useContext(SurfaceContext);
  const ref = useRef<HTMLButtonElement>(null);
  const timer = useRef<number>();
  const open = surface.openSubmenu === id;
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return (
    <>
      <button
        ref={ref}
        type="button"
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        className={`menu-item ${open ? 'expanded' : ''}`}
        onMouseEnter={() => { window.clearTimeout(timer.current); timer.current = window.setTimeout(() => surface.setOpenSubmenu(id), 140); }}
        onMouseLeave={() => window.clearTimeout(timer.current)}
        onClick={() => surface.setOpenSubmenu(open ? null : id)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowRight' || event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            event.stopPropagation();
            surface.setOpenSubmenu(id, true);
          }
        }}
      >
        <span className="menu-item-icon" aria-hidden="true">{Icon ? <Icon size={16} /> : null}</span>
        <span className="menu-item-label">{label}</span>
        <ChevronRight className="menu-item-chevron" size={15} aria-hidden="true" />
      </button>
      {open && (
        <MenuSurface anchor={ref.current} placement="right-start" label={label} autoFocus={surface.openedByKeyboard} onClose={() => surface.setOpenSubmenu(null)}>
          {children}
        </MenuSurface>
      )}
    </>
  );
}

export function MenuSeparator() {
  return <div role="separator" className="menu-separator" />;
}

export function MenuHeading({ children }: { children: ReactNode }) {
  return <div className="menu-heading" role="presentation">{children}</div>;
}
