import { useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { ChevronsRight, Copy, ExternalLink, FileDown, Folder, FolderOpen, Globe2, Pencil, Star, Trash2, Upload, X } from 'lucide-react';
import type { Bookmark, BookmarkBarMode, BookmarkLevelInput } from '../../electron/types';
import { bookmarkEntries, type BookmarkTreeEntry } from '../../electron/bookmark-tree';
import { domainFromUrl } from '../lib/format';
import { MenuItem, MenuSeparator, MenuSurface, SubmenuItem } from './Menu';

export interface BookmarkActions {
  open: (id: string) => void;
  openAll: (items: Bookmark[]) => void;
  copyLink: (url: string) => void;
  rename: (item: Bookmark) => void;
  remove: (item: Bookmark) => void;
  renameFolder: (level: BookmarkLevelInput, name: string) => void;
  removeFolder: (level: BookmarkLevelInput, name: string, count: number) => void;
  move: (level: BookmarkLevelInput, key: { kind: 'bookmark'; id: string } | { kind: 'folder'; name: string }, toIndex: number) => void;
  setMode: (mode: BookmarkBarMode) => void;
  openManager: () => void;
  importBookmarks: () => void;
  exportBookmarks: () => void;
}

type OpenMenu =
  | { kind: 'folder'; name: string; items: Bookmark[]; anchor: HTMLElement }
  | { kind: 'overflow'; anchor: HTMLElement }
  | { kind: 'other'; anchor: HTMLElement }
  | { kind: 'context-bookmark'; item: Bookmark; point: { x: number; y: number } }
  | { kind: 'context-folder'; name: string; items: Bookmark[]; point: { x: number; y: number } }
  | { kind: 'context-bar'; point: { x: number; y: number } };

interface DragState { key: string; from: number; to: number; startX: number; dx: number; width: number; centers: number[]; pointerId: number; active: boolean }

const HINT_KEY = 'private-browser:bookmark-bar-hint-dismissed';

function readHintDismissed(): boolean {
  try { return localStorage.getItem(HINT_KEY) === '1'; } catch { return false; }
}

function entryKey(entry: BookmarkTreeEntry): string {
  return entry.kind === 'bookmark' ? `b:${entry.item.id}` : `f:${entry.name}`;
}

function BookmarkIcon({ item, favicons }: { item: Bookmark; favicons: Map<string, string> }) {
  const icon = favicons.get(domainFromUrl(item.url));
  return icon ? <img src={icon} alt="" draggable={false} /> : <Globe2 size={14} />;
}

/** Recursive folder contents for dropdown menus. */
export function BookmarkFolderContents({ items, path, favicons, onOpen }: { items: Bookmark[]; path: string[]; favicons: Map<string, string>; onOpen: (id: string) => void }) {
  const entries = bookmarkEntries(items, path);
  if (!entries.length) return <p className="menu-empty">This folder is empty</p>;
  return <BookmarkMenuEntries entries={entries} path={path} favicons={favicons} onOpen={onOpen} />;
}

function BookmarkMenuEntries({ entries, path, favicons, onOpen }: { entries: BookmarkTreeEntry[]; path: string[]; favicons: Map<string, string>; onOpen: (id: string) => void }) {
  return (
    <>
      {entries.map((entry) => entry.kind === 'bookmark'
        ? <MenuItem key={entry.item.id} leading={<BookmarkIcon item={entry.item} favicons={favicons} />} label={entry.item.title || domainFromUrl(entry.item.url)} title={entry.item.url} onSelect={() => onOpen(entry.item.id)} />
        : (
          <SubmenuItem key={`${path.join('/')}/${entry.name}`} id={`folder:${[...path, entry.name].join('')}`} icon={Folder} label={entry.name}>
            <BookmarkFolderContents items={entry.descendants} path={[...path, entry.name]} favicons={favicons} onOpen={onOpen} />
          </SubmenuItem>
        ))}
    </>
  );
}

export function BookmarkBar({ bookmarks, mode, favicons, actions }: { bookmarks: Bookmark[]; mode: BookmarkBarMode; favicons: Map<string, string>; actions: BookmarkActions }) {
  const barItems = useMemo(() => bookmarks.filter((item) => item.location === 'bar'), [bookmarks]);
  const otherItems = useMemo(() => bookmarks.filter((item) => item.location === 'other'), [bookmarks]);
  const entries = useMemo(() => bookmarkEntries(barItems, []), [barItems]);
  const [visibleCount, setVisibleCount] = useState(entries.length);
  const [menu, setMenu] = useState<OpenMenu | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [hintDismissed, setHintDismissed] = useState(readHintDismissed);
  const itemsRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const entryRefs = useRef(new Map<string, HTMLElement>());
  const signature = entries.map((entry) => `${entryKey(entry)}:${entry.kind === 'bookmark' ? entry.item.title : entry.name}`).join('|');

  useLayoutEffect(() => {
    const compute = () => {
      const container = itemsRef.current;
      const measure = measureRef.current;
      if (!container || !measure) return;
      const available = container.clientWidth;
      const widths = [...measure.children].map((child) => (child as HTMLElement).offsetWidth + 2);
      let used = 0;
      let count = 0;
      for (let index = 0; index < widths.length; index += 1) {
        const reserve = index < widths.length - 1 ? 34 : 0;
        if (used + widths[index] + reserve > available) break;
        used += widths[index];
        count += 1;
      }
      setVisibleCount(count);
    };
    compute();
    const observer = new ResizeObserver(compute);
    if (itemsRef.current) observer.observe(itemsRef.current);
    return () => observer.disconnect();
  }, [signature]);

  const visible = entries.slice(0, visibleCount);
  const overflow = entries.slice(visibleCount);
  const level: BookmarkLevelInput = { location: 'bar', path: [] };

  const beginDrag = (event: ReactPointerEvent<HTMLButtonElement>, entry: BookmarkTreeEntry, index: number) => {
    if (event.button !== 0) return;
    const rects = visible.map((candidate) => entryRefs.current.get(entryKey(candidate))?.getBoundingClientRect());
    if (rects.some((rect) => !rect)) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrag({ key: entryKey(entry), from: index, to: index, startX: event.clientX, dx: 0, width: rects[index]!.width, centers: rects.map((rect) => rect!.left + rect!.width / 2), pointerId: event.pointerId, active: false });
  };
  const moveDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const dx = event.clientX - drag.startX;
    if (!drag.active && Math.abs(dx) < 5) return;
    const center = drag.centers[drag.from] + dx;
    setDrag({ ...drag, dx, active: true, to: drag.centers.filter((value, index) => index !== drag.from && value < center).length });
  };
  const endDrag = (event: ReactPointerEvent<HTMLButtonElement>, entry: BookmarkTreeEntry) => {
    if (!drag || event.pointerId !== drag.pointerId) return false;
    const moved = drag.active;
    if (moved && drag.to !== drag.from) actions.move(level, entry.kind === 'bookmark' ? { kind: 'bookmark', id: entry.item.id } : { kind: 'folder', name: entry.name }, drag.to);
    setDrag(null);
    return moved;
  };
  const shiftFor = (index: number) => {
    if (!drag?.active || index === drag.from) return 0;
    if (drag.from < drag.to && index > drag.from && index <= drag.to) return -drag.width;
    if (drag.from > drag.to && index >= drag.to && index < drag.from) return drag.width;
    return 0;
  };

  const suppressClick = useRef(false);
  const dismissHint = () => {
    setHintDismissed(true);
    try { localStorage.setItem(HINT_KEY, '1'); } catch { /* the hint simply returns next launch */ }
  };

  return (
    <nav
      className="bookmark-bar"
      aria-label="Bookmarks bar"
      onContextMenu={(event) => {
        if ((event.target as Element).closest('.bookmark-item, .bookmark-bar-hint button')) return;
        event.preventDefault();
        setMenu({ kind: 'context-bar', point: { x: event.clientX, y: event.clientY } });
      }}
    >
      <div className="bookmark-bar-items" ref={itemsRef}>
        {visible.map((entry, index) => {
          const key = entryKey(entry);
          const dragging = drag?.active && drag.key === key;
          const style = { transform: dragging ? `translateX(${drag!.dx}px)` : shiftFor(index) ? `translateX(${shiftFor(index)}px)` : undefined };
          const common = {
            ref: (element: HTMLButtonElement | null) => { if (element) entryRefs.current.set(key, element); else entryRefs.current.delete(key); },
            style,
            onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => beginDrag(event, entry, index),
            onPointerMove: moveDrag,
            onPointerCancel: () => setDrag(null),
            onLostPointerCapture: () => setDrag(null),
          };
          if (entry.kind === 'bookmark') {
            return (
              <button
                key={key}
                type="button"
                className={`bookmark-item ${entry.item.title ? '' : 'icon-only'} ${dragging ? 'dragging' : ''}`}
                aria-label={entry.item.title || domainFromUrl(entry.item.url)}
                title={entry.item.title ? `${entry.item.title}\n${entry.item.url}` : entry.item.url}
                {...common}
                onPointerUp={(event) => { suppressClick.current = endDrag(event, entry); }}
                onClick={() => { if (suppressClick.current) { suppressClick.current = false; return; } actions.open(entry.item.id); }}
                onMouseDown={(event) => { if (event.button === 1) event.preventDefault(); }}
                onAuxClick={(event) => { if (event.button === 1) actions.open(entry.item.id); }}
                onContextMenu={(event) => { event.preventDefault(); setMenu({ kind: 'context-bookmark', item: entry.item, point: { x: event.clientX, y: event.clientY } }); }}
              >
                <BookmarkIcon item={entry.item} favicons={favicons} />
                {entry.item.title && <span>{entry.item.title}</span>}
              </button>
            );
          }
          const open = menu?.kind === 'folder' && menu.name === entry.name;
          return (
            <button
              key={key}
              type="button"
              className={`bookmark-item folder ${open ? 'open' : ''} ${dragging ? 'dragging' : ''}`}
              aria-haspopup="menu"
              aria-expanded={open}
              {...common}
              onPointerUp={(event) => { suppressClick.current = endDrag(event, entry); }}
              onClick={(event) => {
                if (suppressClick.current) { suppressClick.current = false; return; }
                setMenu(open ? null : { kind: 'folder', name: entry.name, items: entry.descendants, anchor: event.currentTarget });
              }}
              onContextMenu={(event) => { event.preventDefault(); setMenu({ kind: 'context-folder', name: entry.name, items: entry.descendants, point: { x: event.clientX, y: event.clientY } }); }}
            >
              {open ? <FolderOpen size={15} /> : <Folder size={15} />}
              <span>{entry.name}</span>
            </button>
          );
        })}
        {!entries.length && !otherItems.length && !hintDismissed && mode === 'always' && (
          <span className="bookmark-bar-hint">
            For quick access, star pages or
            <button type="button" className="link-button" onClick={actions.importBookmarks}>import bookmarks</button>
            <button type="button" className="hint-dismiss" aria-label="Dismiss bookmarks tip" onClick={dismissHint}><X size={13} /></button>
          </span>
        )}
      </div>
      {overflow.length > 0 && (
        <button type="button" className={`bookmark-item bookmark-overflow ${menu?.kind === 'overflow' ? 'open' : ''}`} aria-label={`${overflow.length} more bookmarks`} aria-haspopup="menu" aria-expanded={menu?.kind === 'overflow'} title="More bookmarks" onClick={(event) => setMenu(menu?.kind === 'overflow' ? null : { kind: 'overflow', anchor: event.currentTarget })}>
          <ChevronsRight size={16} />
        </button>
      )}
      {otherItems.length > 0 && (
        <button type="button" className={`bookmark-item bookmark-other ${menu?.kind === 'other' ? 'open' : ''}`} aria-haspopup="menu" aria-expanded={menu?.kind === 'other'} onClick={(event) => setMenu(menu?.kind === 'other' ? null : { kind: 'other', anchor: event.currentTarget })}>
          <Folder size={15} /><span>Other bookmarks</span>
        </button>
      )}
      <div className="bookmark-measure" aria-hidden="true" ref={measureRef}>
        {entries.map((entry) => {
          const label = entry.kind === 'bookmark' ? entry.item.title : entry.name;
          return <span key={entryKey(entry)} className={`bookmark-item ${label ? '' : 'icon-only'}`}><Globe2 size={14} />{label && <span>{label}</span>}</span>;
        })}
      </div>

      {menu?.kind === 'folder' && (
        <MenuSurface anchor={menu.anchor} label={menu.name} className="bookmark-menu" onClose={() => setMenu(null)}>
          <BookmarkFolderContents items={menu.items} path={[menu.name]} favicons={favicons} onOpen={actions.open} />
        </MenuSurface>
      )}
      {menu?.kind === 'overflow' && (
        <MenuSurface anchor={menu.anchor} placement="bottom-end" label="More bookmarks" className="bookmark-menu" onClose={() => setMenu(null)}>
          <BookmarkMenuEntries entries={overflow} path={[]} favicons={favicons} onOpen={actions.open} />
        </MenuSurface>
      )}
      {menu?.kind === 'other' && (
        <MenuSurface anchor={menu.anchor} placement="bottom-end" label="Other bookmarks" className="bookmark-menu" onClose={() => setMenu(null)}>
          <BookmarkFolderContents items={otherItems} path={[]} favicons={favicons} onOpen={actions.open} />
        </MenuSurface>
      )}
      {menu?.kind === 'context-bookmark' && (
        <MenuSurface point={menu.point} label={`${menu.item.title || domainFromUrl(menu.item.url)} actions`} className="context-menu" onClose={() => setMenu(null)}>
          <MenuItem icon={ExternalLink} label="Open in new tab" onSelect={() => actions.open(menu.item.id)} />
          <MenuItem icon={Copy} label="Copy link" onSelect={() => actions.copyLink(menu.item.url)} />
          <MenuSeparator />
          <MenuItem icon={Pencil} label="Edit name…" onSelect={() => actions.rename(menu.item)} />
          <MenuItem icon={Trash2} danger label="Delete" onSelect={() => actions.remove(menu.item)} />
        </MenuSurface>
      )}
      {menu?.kind === 'context-folder' && (
        <MenuSurface point={menu.point} label={`${menu.name} folder actions`} className="context-menu" onClose={() => setMenu(null)}>
          <MenuItem icon={ExternalLink} label={`Open all (${menu.items.length})`} onSelect={() => actions.openAll(menu.items)} />
          <MenuSeparator />
          <MenuItem icon={Pencil} label="Rename folder…" onSelect={() => actions.renameFolder(level, menu.name)} />
          <MenuItem icon={Trash2} danger label="Delete folder…" onSelect={() => actions.removeFolder(level, menu.name, menu.items.length)} />
        </MenuSurface>
      )}
      {menu?.kind === 'context-bar' && (
        <MenuSurface point={menu.point} label="Bookmarks bar actions" className="context-menu" onClose={() => setMenu(null)}>
          <MenuItem role="menuitemradio" checked={mode === 'always'} label="Always show bookmarks bar" onSelect={() => actions.setMode('always')} />
          <MenuItem role="menuitemradio" checked={mode === 'new-tab'} label="Show only on New Tab" onSelect={() => actions.setMode('new-tab')} />
          <MenuItem role="menuitemradio" checked={false} label="Hide bookmarks bar" onSelect={() => actions.setMode('hidden')} />
          <MenuSeparator />
          <MenuItem icon={Star} label="Bookmark manager" onSelect={actions.openManager} />
          <MenuItem icon={Upload} label="Import bookmarks and history" onSelect={actions.importBookmarks} />
          <MenuItem icon={FileDown} label="Export bookmarks" onSelect={actions.exportBookmarks} />
        </MenuSurface>
      )}
    </nav>
  );
}
