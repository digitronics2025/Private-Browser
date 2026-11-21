/**
 * Runs in a named Chromium isolated world. Only the browser's fixed commands
 * reach this function. Inputs are JSON data, including diagnostic expressions.
 */
export function createAgentPage() {
  const doc = document;
  const refs = new Map<string, HTMLElement>();
  const ids = new WeakMap<HTMLElement, string>();
  const sensitive = new WeakSet<HTMLElement>();
  let next = 0;
  let sequence = 0;
  const documentId = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('');
  const observer = new MutationObserver(() => { sequence += 1; });
  observer.observe(doc, { childList: true, subtree: true, attributes: true, characterData: true });
  for (const type of ['input', 'change']) doc.addEventListener(type, () => { sequence += 1; }, true);
  let largestContentfulPaintMs: number | undefined;
  let layoutShift = 0;
  let shiftWindow = { start: 0, latest: 0, score: 0 };
  const observe = (type: string, consume: (entry: PerformanceEntry) => void) => {
    if (PerformanceObserver.supportedEntryTypes.includes(type)) {
      new PerformanceObserver((list) => list.getEntries().forEach(consume)).observe({ type, buffered: true });
    }
  };
  observe('largest-contentful-paint', (entry) => { largestContentfulPaintMs = entry.startTime; });
  observe('layout-shift', (entry) => {
    const shift = entry as PerformanceEntry & { hadRecentInput: boolean; value: number };
    if (shift.hadRecentInput) return;
    if (shift.startTime - shiftWindow.latest > 1_000 || shift.startTime - shiftWindow.start > 5_000) {
      shiftWindow = { start: shift.startTime, latest: shift.startTime, score: 0 };
    }
    shiftWindow.latest = shift.startTime;
    shiftWindow.score += shift.value;
    layoutShift = Math.max(layoutShift, shiftWindow.score);
  });
  const revision = () => {
    if (observer.takeRecords().length) sequence += 1;
    return `${documentId}:${sequence}:${location.href}`;
  };

  const selectors = 'a[href],button,input,select,textarea,summary,[role],[contenteditable],[tabindex],h1,h2,h3,h4,h5,h6,main,nav,article,section,form,p,li,img,label';
  const privateField = /(?:pass(?:word|code|wd)?|mot[-_ ]?de[-_ ]?passe|one[-_ ]?time|\botp\b|\bpin\b|\bcvv\b|\bcvc\b|card|carte|iban|secret|token|verification[-_ ]?code|رمز|كلمة المرور)/iu;
  const privateType = /^(?:password|hidden|file)$/i;
  const compact = (input: string | null | undefined, limit = 220) => (input ?? '').replace(/\s+/g, ' ').trim().slice(0, limit);
  const isInput = (element: HTMLElement): element is HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement =>
    element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement;
  const label = (element: HTMLElement) => isInput(element) ? Array.from(element.labels ?? []).map((part) => compact(part.innerText)).join(' ') : '';
  const hint = (element: HTMLElement) => [
    label(element), element.getAttribute('name'), element.getAttribute('id'), element.getAttribute('aria-label'),
    element.getAttribute('placeholder'), element.getAttribute('autocomplete'),
  ].join(' ');
  const isPrivate = (element: HTMLElement) => {
    if (sensitive.has(element)) return true;
    if (element instanceof HTMLInputElement && privateType.test(element.type)
      || (isInput(element) || element.isContentEditable || element.getAttribute('role') === 'textbox') && privateField.test(hint(element))) {
      sensitive.add(element);
      return true;
    }
    return false;
  };
  const siteApprovalRevision = () => {
    const walker = doc.createTreeWalker(doc, NodeFilter.SHOW_ELEMENT);
    for (let node = walker.nextNode(), scanned = 0; node; node = walker.nextNode(), scanned += 1) {
      if (scanned >= 5_000) return null;
      if (!(node instanceof Element)) continue;
      // Embedded documents and component internals cannot be safely reviewed here.
      if (node.matches('iframe,frame,fencedframe,object,embed') || node.shadowRoot || node.localName.includes('-')) return null;
      if (node instanceof HTMLElement && (isPrivate(node) || /(?:^|\s)cc-[a-z-]+(?:\s|$)/i.test(node.getAttribute('autocomplete') ?? ''))) return null;
    }
    return revision();
  };

  const containingPrivate = (element: HTMLElement) => {
    for (let node: HTMLElement | null = element; node; node = node.parentElement) if (isPrivate(node)) return true;
    return false;
  };
  const visible = (element: HTMLElement) => element.isConnected && Boolean(element.getClientRects().length)
    && (() => { const style = getComputedStyle(element); return style.visibility === 'visible' && style.display !== 'none'; })();
  const name = (element: HTMLElement) => {
    if (isPrivate(element)) return '[redacted]';
    const described = (element.getAttribute('aria-labelledby') ?? '').split(/\s+/).slice(0, 8)
      .map((id) => doc.getElementById(id)).filter((node): node is HTMLElement => Boolean(node && !containingPrivate(node)))
      .map((node) => node.innerText).join(' ');
    const short = compact(element.getAttribute('aria-label') || described || label(element)
      || element.getAttribute('alt') || element.getAttribute('title') || element.getAttribute('placeholder'));
    if (short || isInput(element) || element.isContentEditable) return short;
    return compact(textOf(element, 220));
  };
  const role = (element: HTMLElement) => {
    const explicit = compact(element.getAttribute('role'), 40).split(' ')[0];
    if (explicit) return explicit;
    if (element instanceof HTMLInputElement) {
      if (['button', 'submit', 'reset', 'image'].includes(element.type)) return 'button';
      if (['checkbox', 'radio'].includes(element.type)) return element.type;
      if (element.type === 'range') return 'slider';
      return 'textbox';
    }
    if (element instanceof HTMLSelectElement) return element.multiple ? 'listbox' : 'combobox';
    if (element instanceof HTMLTextAreaElement || element.isContentEditable) return 'textbox';
    if (/^H[1-6]$/.test(element.tagName)) return 'heading';
    const roles: Record<string, string> = { A: 'link', BUTTON: 'button', SUMMARY: 'button', IMG: 'img', LI: 'listitem', NAV: 'navigation', P: 'paragraph', LABEL: 'label' };
    return roles[element.tagName] ?? element.tagName.toLowerCase();
  };
  function textOf(root: Node, limit: number): string {
    const walk = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const chunks: string[] = [];
    let bytes = 0;
    for (let node = walk.nextNode(), seen = 0; node && bytes < limit && seen < 6_000; node = walk.nextNode(), seen += 1) {
      const parent = node.parentElement;
      if (!parent || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(parent.tagName) || containingPrivate(parent) || !visible(parent)) continue;
      const part = compact(node.nodeValue, limit - bytes);
      if (part) { chunks.push(part); bytes += part.length + 1; }
    }
    return chunks.join(' ').slice(0, limit);
  }
  const target = (ref: string) => {
    const element = refs.get(ref);
    if (!element || !visible(element)) throw new Error('stale reference');
    return element;
  };
  const rect = (element: HTMLElement) => {
    const value = element.getBoundingClientRect();
    return { x: value.x + window.scrollX, y: value.y + window.scrollY, width: value.width, height: value.height };
  };
  const snapshot = () => {
    refs.clear();
    const nodes = [];
    const walker = doc.createTreeWalker(doc.body ?? doc.documentElement, NodeFilter.SHOW_ELEMENT);
    for (let node = walker.nextNode(), scanned = 0; node && nodes.length < 175 && scanned < 5_000; node = walker.nextNode(), scanned += 1) {
      if (!(node instanceof HTMLElement) || !node.matches(selectors) || !visible(node)) continue;
      const element = node;
      let ref = ids.get(element);
      if (!ref) {
        if (next >= 9999) throw new Error('reference limit');
        ref = `e${++next}-${documentId.slice(0, 12)}`;
        ids.set(element, ref);
      }
      refs.set(ref, element);
      const privateValue = containingPrivate(element);
      nodes.push({
        ref, role: role(element), name: privateValue ? '[redacted]' : name(element),
        value: privateValue ? '[redacted]' : isInput(element) ? compact(element.value, 160) : undefined,
        checked: element instanceof HTMLInputElement && ['checkbox', 'radio'].includes(element.type) ? element.checked : undefined,
        disabled: element.matches(':disabled') || element.getAttribute('aria-disabled') === 'true',
      });
    }
    return { revision: revision(), nodes };
  };
  const details = (element: HTMLElement) => {
    const control = element.closest('button,input,textarea,select') ?? element;
    const form = isInput(control as HTMLElement) || control instanceof HTMLButtonElement
      ? (control as HTMLInputElement).form : control.closest('form');
    const method = control.getAttribute('formmethod') ?? form?.getAttribute('method') ?? 'get';
    const action = control.getAttribute('formaction') ?? form?.getAttribute('action') ?? location.href;
    const formTarget = form ? new URL(action, doc.baseURI).href : undefined;
    return {
      private: containingPrivate(element), role: role(element), name: name(element),
      nearby: textOf(element.parentElement ?? element, 200),
      formMethod: form ? method : undefined, formTarget,
      link: element.closest('a[href]') instanceof HTMLAnchorElement ? (element.closest('a[href]') as HTMLAnchorElement).href : undefined,
      submit: Boolean(form && (control instanceof HTMLButtonElement && control.type === 'submit'
        || control instanceof HTMLInputElement && ['submit', 'image'].includes(control.type))),
    };
  };
  const change = (element: HTMLElement) => {
    element.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  };
  return (command: string, args: { ref?: string; fromRef?: string; toRef?: string; expected?: string; expectedOrigin?: string; text?: string; submit?: boolean; value?: string; checked?: boolean; key?: string; x?: number; y?: number; expression?: string }) => {
    if (args.expectedOrigin !== undefined && location.origin !== args.expectedOrigin) throw new Error('frame changed');
    if (args.expected !== undefined && revision() !== args.expected) throw new Error('page changed');
    if (command === 'snapshot') return snapshot();
    if (command === 'revision') return revision();
    if (command === 'siteApprovalRevision') return siteApprovalRevision();
    if (command === 'text') return textOf(args.ref ? target(args.ref) : doc.body ?? doc.documentElement, 12_000);
    if (command === 'metrics') {
      const entry = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
      return entry ? {
        domInteractiveMs: entry.domInteractive, domContentLoadedMs: entry.domContentLoadedEventEnd,
        loadMs: entry.loadEventEnd, responseStartMs: entry.responseStart, transferBytes: entry.transferSize,
        firstContentfulPaintMs: performance.getEntriesByName('first-contentful-paint', 'paint')[0]?.startTime,
        largestContentfulPaintMs, cumulativeLayoutShift: layoutShift,
      } : {};
    }
    if (command === 'evaluate') {
      switch (args.expression?.trim()) {
        case 'document.title': return compact(doc.title, 300);
        case 'document.readyState': return doc.readyState;
        case 'location.origin': return location.origin;
        case 'window.innerWidth': return window.innerWidth;
        case 'window.innerHeight': return window.innerHeight;
        default: throw new Error('unsupported diagnostic');
      }
    }
    if (command === 'mask') {
      const elements = doc.querySelectorAll('*');
      if (elements.length > 8_000) throw new Error('mask limit');
      return {
        revision: revision(), crop: args.ref ? rect(target(args.ref)) : undefined,
        x: window.scrollX, y: window.scrollY, width: window.innerWidth, height: window.innerHeight,
        masks: Array.from(elements).filter((element): element is HTMLElement => element instanceof HTMLElement)
          .filter((element) => (isPrivate(element) || element.shadowRoot || element.localName.includes('-')
            || /^(IFRAME|FRAME|OBJECT|EMBED|CANVAS|VIDEO)$/.test(element.tagName)) && visible(element))
          .map(rect),
      };
    }
    if (command === 'scroll') { window.scrollBy({ left: args.x ?? 0, top: args.y ?? 0, behavior: 'instant' }); return null; }
    if (command === 'key') {
      const active = doc.activeElement;
      if (!(active instanceof HTMLElement) || /^(IFRAME|FRAME|OBJECT|EMBED)$/.test(active.tagName) || containingPrivate(active)) throw new Error('sensitive focus');
      if (args.key === 'Enter' && (active instanceof HTMLButtonElement || active instanceof HTMLAnchorElement)) active.click();
      else if (args.key === 'Enter' && isInput(active)) active.form?.requestSubmit();
      else active.dispatchEvent(new KeyboardEvent('keydown', { key: args.key, bubbles: true, cancelable: true }));
      return null;
    }
    if (command === 'drag') {
      const from = target(args.fromRef!);
      const to = target(args.toRef!);
      if (containingPrivate(from) || containingPrivate(to)) throw new Error('sensitive target');
      const data = new DataTransfer();
      const event = (type: string) => new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: data });
      from.dispatchEvent(event('dragstart'));
      to.dispatchEvent(event('dragenter'));
      to.dispatchEvent(event('dragover'));
      to.dispatchEvent(event('drop'));
      from.dispatchEvent(event('dragend'));
      return null;
    }
    const element = target(args.ref!);
    if (command === 'highlight') return rect(element);
    if (command === 'inspect') return { revision: revision(), ...details(element) };
    if (command === 'file') {
      if (!(element instanceof HTMLInputElement) || element.type !== 'file' || element.disabled) throw new Error('choose a file input');
      return element;
    }
    if (containingPrivate(element) || element.matches(':disabled') || element.getAttribute('aria-disabled') === 'true') throw new Error('sensitive or disabled target');
    switch (command) {
      case 'click': element.click(); return null;
      case 'hover': element.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); return null;
      case 'type': {
        if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) throw new Error('choose a text input');
        if (element.readOnly || element instanceof HTMLInputElement && !['text', 'email', 'number', 'search', 'url', 'tel'].includes(element.type)) throw new Error('choose an editable text input');
        const proto = element instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(element, args.text ?? '');
        change(element);
        if (args.submit) element.form?.requestSubmit();
        return null;
      }
      case 'select': {
        if (!(element instanceof HTMLSelectElement) || !Array.from(element.options).some((option) => option.value === args.value && !option.disabled)) throw new Error('choose an available option');
        element.value = args.value!;
        change(element);
        return null;
      }
      case 'check': {
        if (!(element instanceof HTMLInputElement) || element.type !== 'checkbox') throw new Error('choose a checkbox');
        if (element.checked !== args.checked) element.click();
        return null;
      }
      default: throw new Error('unsupported command');
    }
  };
}
