import type { ReactNode } from 'react';

type OpenLink = (url: string) => void;

function inline(text: string, open: OpenLink): ReactNode[] {
  const result: ReactNode[] = [];
  const tokens = /`([^`\n]{1,512})`|\*\*([^*\n]{1,512})\*\*|\*([^*\n]{1,512})\*|\[([^\]\n]{1,256})\]\(([^()\s]{1,2048})\)/g;
  let start = 0;
  for (const match of text.matchAll(tokens)) {
    const index = match.index!;
    result.push(text.slice(start, index));
    if (match[1]) result.push(<code key={index}>{match[1]}</code>);
    else if (match[2]) result.push(<strong key={index}>{match[2]}</strong>);
    else if (match[3]) result.push(<em key={index}>{match[3]}</em>);
    else {
      let url: URL | undefined;
      try { url = new URL(match[5]); } catch { /* display invalid links as text */ }
      result.push(url && /^https?:$/.test(url.protocol) && !url.username && !url.password
        ? <button key={index} type="button" className="text-button" onClick={() => open(url.href)}>{match[4]} ({url.href})</button>
        : match[0]);
    }
    start = index + match[0].length;
  }
  result.push(text.slice(start));
  return result;
}

export function AssistantMarkdown({ text, onOpen }: { text: string; onOpen: OpenLink }) {
  const lines = text.slice(0, 30_000).split(/\r?\n/);
  const blocks: ReactNode[] = [];
  const cells = (row: string) => row.trim().replace(/^\||\|$/g, '').split('|').map(cell => cell.trim());
  const list = /^(\d+\.|[-*])\s+(.+)/;
  for (let i = 0; i < lines.length;) {
    const key = i;
    const line = lines[i++];
    if (!line.trim()) continue;
    if (line.startsWith('```')) {
      const code = [];
      while (i < lines.length && !lines[i].startsWith('```')) code.push(lines[i++]);
      i++;
      blocks.push(<pre key={key}><code>{code.join('\n')}</code></pre>);
    } else if (/^#{1,6} /.test(line)) {
      const Heading = ('h' + line.indexOf(' ')) as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
      blocks.push(<Heading key={key}>{inline(line.slice(line.indexOf(' ') + 1), onOpen)}</Heading>);
    } else if (line.includes('|') && lines[i]?.includes('|') && cells(lines[i]).every(cell => /^:?-{3,}:?$/.test(cell))) {
      i++;
      const rows = [];
      while (i < lines.length && lines[i].includes('|')) rows.push(cells(lines[i++]));
      blocks.push(<table key={key}><thead><tr>{cells(line).map((cell, n) => <th key={n}>{inline(cell, onOpen)}</th>)}</tr></thead>
        <tbody>{rows.map((row, r) => <tr key={r}>{row.map((cell, n) => <td key={n}>{inline(cell, onOpen)}</td>)}</tr>)}</tbody></table>);
    } else if (list.test(line)) {
      const List = /^\d/.test(line) ? 'ol' : 'ul';
      const items = [line];
      while (i < lines.length && list.test(lines[i]) && (/^\d/.test(lines[i]) === (List === 'ol'))) items.push(lines[i++]);
      blocks.push(<List key={key}>{items.map((item, n) => <li key={n}>{inline(item.replace(list, '$2'), onOpen)}</li>)}</List>);
    } else blocks.push(<p key={key}>{inline(line, onOpen)}</p>);
  }
  return <>{blocks}</>;
}
