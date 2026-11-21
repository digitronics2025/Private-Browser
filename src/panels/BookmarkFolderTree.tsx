import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Folder } from 'lucide-react';
import type { BookmarkLevelInput } from '../../electron/types';
import { bookmarkFolderKey } from '../../electron/bookmark-maintenance';

function Branch({ level, childrenByParent, selected, onSelect }: {
  level: BookmarkLevelInput;
  childrenByParent: Map<string, BookmarkLevelInput[]>;
  selected: string;
  onSelect: (level?: BookmarkLevelInput) => void;
}) {
  const [open, setOpen] = useState(level.path.length === 0);
  const key = bookmarkFolderKey(level);
  const children = childrenByParent.get(key) ?? [];
  const label = level.path.at(-1) ?? (level.location === 'bar' ? 'Bookmarks bar' : 'Other bookmarks');
  return <li>
    <div className="bookmark-folder-row">
      {children.length > 0 && <button type="button" aria-label={(open ? 'Collapse ' : 'Expand ') + label}
        aria-expanded={open} onClick={() => setOpen(!open)}>{open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</button>}
      <button type="button" aria-pressed={selected === key} onClick={() => onSelect(level)}><Folder size={13} /> {label}</button>
    </div>
    {open && children.length > 0 && <ul>{children.map((child) => <Branch key={bookmarkFolderKey(child)} level={child}
      childrenByParent={childrenByParent} selected={selected} onSelect={onSelect} />)}</ul>}
  </li>;
}

export function BookmarkFolderTree({ folders, selected, onSelect }: {
  folders: BookmarkLevelInput[];
  selected?: BookmarkLevelInput;
  onSelect: (level?: BookmarkLevelInput) => void;
}) {
  const grouped = useMemo(() => {
    const children = new Map<string, BookmarkLevelInput[]>();
    for (const item of folders) {
      const parent = item.path.length ? bookmarkFolderKey({ location: item.location, path: item.path.slice(0, -1) }) : '';
      const entries = children.get(parent);
      if (entries) entries.push(item);
      else children.set(parent, [item]);
    }
    return children;
  }, [folders]);
  return <nav className="bookmark-folder-tree" aria-label="Bookmark folders">
    <button type="button" aria-pressed={!selected} onClick={() => onSelect()}>All bookmarks</button>
    <ul>{grouped.get('')?.map((level) => <Branch key={bookmarkFolderKey(level)} level={level} childrenByParent={grouped}
      selected={selected ? bookmarkFolderKey(selected) : ''} onSelect={onSelect} />)}</ul>
  </nav>;
}
