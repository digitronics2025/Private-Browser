import { useRef, useState, type CSSProperties, type FormEvent } from 'react';
import { Clock3, MoreVertical, Palette, Pencil, Plus, RotateCcw, Search, Star, Trash2 } from 'lucide-react';
import type { AccountSpaceSummary, Bookmark, HistoryEntry, NewTabBackground, ShortcutTile, ThemePreference, Workspace } from '../../electron/types';
import { domainFromUrl, timeAgo } from '../lib/format';
import { BrandMark } from './BrandMark';
import { MenuHeading, MenuItem, MenuSeparator, MenuSurface } from './Menu';

const BACKGROUNDS: Array<{ id: NewTabBackground; label: string }> = [
  { id: 'plain', label: 'Plain' },
  { id: 'lagoon', label: 'Lagoon' },
  { id: 'dusk', label: 'Dusk' },
  { id: 'mist', label: 'Mist' },
  { id: 'graphite', label: 'Graphite' },
];

export const MAX_SHORTCUTS = 12;

function tileHue(value: string): number {
  let hash = 0;
  for (const character of value) hash = (hash * 31 + character.charCodeAt(0)) % 360;
  return hash;
}

export function NewTabPage({ searchPrompt, workspace, account, shortcuts, customized, history, bookmarks, favicons, background, theme, onNavigate, onOpenBookmark, onAddShortcut, onEditShortcut, onRemoveShortcut, onResetShortcuts, onBackground, onTheme }: {
  searchPrompt: string;
  workspace: Workspace;
  account: AccountSpaceSummary;
  shortcuts: ShortcutTile[];
  customized: boolean;
  history: HistoryEntry[];
  bookmarks: Bookmark[];
  favicons: Map<string, string>;
  background: NewTabBackground;
  theme: ThemePreference;
  onNavigate: (value: string) => void;
  onOpenBookmark: (id: string) => void;
  onAddShortcut: () => void;
  onEditShortcut: (tile: ShortcutTile) => void;
  onRemoveShortcut: (tile: ShortcutTile) => void;
  onResetShortcuts: () => void;
  onBackground: (background: NewTabBackground) => void;
  onTheme: (theme: ThemePreference) => void;
}) {
  const [query, setQuery] = useState('');
  const [tileMenu, setTileMenu] = useState<{ tile: ShortcutTile; anchor: HTMLElement } | null>(null);
  const [customizeOpen, setCustomizeOpen] = useState(false);
  const customizeRef = useRef<HTMLButtonElement>(null);
  const recent = history.slice(0, 6);
  const saved = bookmarks.slice(0, 6);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (query.trim()) onNavigate(query);
  };

  return (
    <main className={`new-tab-page ntp-bg-${background}`} aria-label="New Tab">
      <div className="ntp-center">
        <div className="ntp-brand">
          <BrandMark size={56} />
          <h1>Private Browser</h1>
        </div>
        <form className="ntp-search" role="search" onSubmit={submit}>
          <Search size={20} aria-hidden="true" />
          <input aria-label={searchPrompt} placeholder={searchPrompt} value={query} onChange={(event) => setQuery(event.target.value)} spellCheck={false} autoComplete="off" />
        </form>
        <p className="ntp-context">
          <span className="ntp-space-dot" style={{ '--workspace-color': workspace.color } as CSSProperties} aria-hidden="true" />
          {account.label === workspace.name ? workspace.name : `${workspace.name} · ${account.label}`}
        </p>

        <section className="ntp-shortcuts" aria-label="Shortcuts">
          {shortcuts.map((tile) => {
            const icon = favicons.get(domainFromUrl(tile.url));
            return (
              <div className="ntp-tile" key={tile.id}>
                <button type="button" className="ntp-tile-link" title={tile.url} onClick={() => onNavigate(tile.url)}>
                  <span className="ntp-tile-icon" style={{ '--tile-hue': tileHue(domainFromUrl(tile.url)) } as CSSProperties} aria-hidden="true">
                    {icon ? <img src={icon} alt="" /> : (tile.title || domainFromUrl(tile.url)).slice(0, 1).toUpperCase()}
                  </span>
                  <span className="ntp-tile-title">{tile.title}</span>
                </button>
                <button type="button" className="ntp-tile-more" aria-label={`Edit shortcut ${tile.title}`} aria-haspopup="menu" onClick={(event) => setTileMenu({ tile, anchor: event.currentTarget })}><MoreVertical size={14} /></button>
              </div>
            );
          })}
          {shortcuts.length < MAX_SHORTCUTS && (
            <div className="ntp-tile">
              <button type="button" className="ntp-tile-link" onClick={onAddShortcut}>
                <span className="ntp-tile-icon add" aria-hidden="true"><Plus size={20} /></span>
                <span className="ntp-tile-title">Add shortcut</span>
              </button>
            </div>
          )}
        </section>

        {(recent.length > 0 || saved.length > 0) && (
          <div className="ntp-lists">
            {recent.length > 0 && (
              <section className="ntp-card" aria-labelledby="ntp-recent-title">
                <h2 id="ntp-recent-title"><Clock3 size={15} aria-hidden="true" /> Recently visited</h2>
                {recent.map((item) => (
                  <button type="button" className="ntp-row" key={item.id} onClick={() => onNavigate(item.url)}>
                    <span className="ntp-row-main"><strong>{item.title || domainFromUrl(item.url)}</strong><small>{domainFromUrl(item.url)}</small></span>
                    <time dateTime={item.visitedAt}>{timeAgo(item.visitedAt)}</time>
                  </button>
                ))}
              </section>
            )}
            {saved.length > 0 && (
              <section className="ntp-card" aria-labelledby="ntp-bookmarks-title">
                <h2 id="ntp-bookmarks-title"><Star size={15} aria-hidden="true" /> Bookmarks</h2>
                {saved.map((item) => (
                  <button type="button" className="ntp-row" key={item.id} onClick={() => onOpenBookmark(item.id)}>
                    <span className="ntp-row-main"><strong>{item.title}</strong><small>{domainFromUrl(item.url)}</small></span>
                  </button>
                ))}
              </section>
            )}
          </div>
        )}
      </div>

      <button ref={customizeRef} type="button" className="ntp-customize" aria-haspopup="dialog" aria-expanded={customizeOpen} onClick={() => setCustomizeOpen((value) => !value)}>
        <Palette size={16} /> Customize
      </button>

      {tileMenu && (
        <MenuSurface anchor={tileMenu.anchor} placement="bottom-end" label={`${tileMenu.tile.title} shortcut`} className="context-menu" onClose={() => setTileMenu(null)}>
          <MenuItem icon={Pencil} label="Edit shortcut…" onSelect={() => onEditShortcut(tileMenu.tile)} />
          <MenuItem icon={Trash2} danger label="Remove" onSelect={() => onRemoveShortcut(tileMenu.tile)} />
        </MenuSurface>
      )}
      {customizeOpen && (
        <MenuSurface anchor={customizeRef.current} placement="bottom-end" label="Customize New Tab" role="dialog" className="customize-menu" onClose={() => setCustomizeOpen(false)}>
          <MenuHeading>Theme</MenuHeading>
          <MenuItem role="menuitemradio" checked={theme === 'system'} label="Match Windows" keepOpen onSelect={() => onTheme('system')} />
          <MenuItem role="menuitemradio" checked={theme === 'light'} label="Light" keepOpen onSelect={() => onTheme('light')} />
          <MenuItem role="menuitemradio" checked={theme === 'dark'} label="Dark" keepOpen onSelect={() => onTheme('dark')} />
          <MenuHeading>Background</MenuHeading>
          <div className="background-swatches">
            {BACKGROUNDS.map((item) => (
              <button key={item.id} type="button" role="menuitemradio" aria-checked={background === item.id} aria-label={`${item.label} background`} title={item.label} className={`background-swatch ntp-bg-${item.id} ${background === item.id ? 'active' : ''}`} onClick={() => onBackground(item.id)} />
            ))}
          </div>
          <MenuSeparator />
          <MenuItem icon={RotateCcw} label="Restore default shortcuts" disabled={!customized} onSelect={onResetShortcuts} />
        </MenuSurface>
      )}
    </main>
  );
}
