import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { AssistantMarkdown } from '../src/lib/AssistantMarkdown';

it('formats tables and lists, escapes HTML and offers only safe web destinations', () => {
  const input = ['# Catalogue', '- **Brass**', '| Item |', '| --- |', '| Kettle |',
    '<script>placeholder</script>', '[invalid](javascript:noop)', '[file](file:///sample)', '[data](data:text/plain,hi)',
    '[website](https://example.com/path)', 'x'.repeat(40_000)].join('\n');
  const html = renderToStaticMarkup(<AssistantMarkdown text={input} onOpen={() => {}} />);
  expect(html).toContain('<table>');
  expect(html).toContain('<li><strong>Brass</strong></li>');
  expect(html).toContain('&lt;script&gt;');
  expect(html.match(/<button/g)).toHaveLength(1);
  expect(html).toContain('website (https://example.com/path)');
  expect(html.length).toBeLessThan(31_000);
});
