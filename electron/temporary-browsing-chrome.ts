export const TEMPORARY_TOOLBAR_HEIGHT = 118;

export function temporaryBrowsingHtml(nonce: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'">
  <title>Temporary browsing</title>
  <style nonce="${nonce}">
    * { box-sizing: border-box; }
    :root { color-scheme: dark; font-family: system-ui, sans-serif; background: #141923; color: #f2f5fa; }
    body { margin: 0; }
    header { height: ${TEMPORARY_TOOLBAR_HEIGHT}px; padding: 7px 12px; border-bottom: 1px solid #38455d; background: #1c2535; }
    .banner { display: flex; align-items: center; gap: 8px; min-height: 27px; font-size: 12px; }
    .banner strong { font-size: 14px; }
    .banner span { flex: 1; color: #c3cde0; }
    form { display: flex; align-items: center; gap: 6px; margin: 7px 0; }
    button, input { border: 1px solid #556482; border-radius: 6px; color: inherit; background: #253149; font: inherit; min-height: 32px; }
    button { padding: 3px 7px; font-size: 12px; white-space: nowrap; cursor: pointer; }
    button:disabled { opacity: .53; cursor: default; }
    button:focus-visible, input:focus-visible { outline: 2px solid #a8c3ff; outline-offset: 1px; }
    input { padding: 4px 9px; flex: 1; min-width: 0; font-size: 14px; background: #18202f; }
    #notice { margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-height: 18px; color: #fae5b8; font-size: 12px; }
    main { position: absolute; inset: ${TEMPORARY_TOOLBAR_HEIGHT}px 0 0; display: grid; justify-content: center; align-content: center; gap: 4px; text-align: center; background: #141923; }
    h1 { margin: 0; font-size: 28px; }
    main p { color: #c3cde0; margin: 6px; }
  </style>
</head>
<body>
  <header>
    <div class="banner"><strong>Temporary browsing</strong><span>Website data and history clear when this window closes.</span><button type="button" id="close">Close window</button></div>
    <form aria-label="Temporary address">
      <button type="button" id="back" disabled>Back</button>
      <button type="button" id="forward" disabled>Forward</button>
      <button type="button" id="reload" disabled>Reload</button>
      <input id="address" aria-label="Address" autocomplete="off" spellcheck="false" maxlength="4096" placeholder="Enter a web address" autofocus>
      <button type="submit">Go</button>
      <button type="button" id="keep" disabled>Keep bookmark</button>
    </form>
    <p id="notice" role="status"></p>
  </header>
  <main><h1>Temporary browsing</h1><p>Enter a web address to begin. Downloads and pop-ups are blocked.</p></main>
  <script nonce="${nonce}">
    const view = window.temporaryChrome;
    const address = document.getElementById('address');
    const notice = document.getElementById('notice');
    const back = document.getElementById('back');
    const forward = document.getElementById('forward');
    const reload = document.getElementById('reload');
    const keep = document.getElementById('keep');

    async function command(name, value) {
      try { return await view.command(name, value); }
      catch (error) {
        notice.textContent = String(error.message || 'Temporary browsing action failed.').replace(/^Error invoking remote method '[^']+': Error: /, '');
      }
    }

    let editing = false;
    function show(state) {
      if (!state) return;
      if (!editing) address.value = state.address;
      back.disabled = !state.canBack;
      forward.disabled = !state.canForward;
      reload.disabled = !state.address && !state.loading;
      reload.textContent = state.loading ? 'Stop' : 'Reload';
      keep.disabled = !state.canKeep || state.loading;
      keep.title = 'Save to ' + state.destination;
      const warning = state.warning === 'insecure' ? 'Connection is unencrypted.' : state.warning === 'idn' ? 'Check this international address before signing in.' : '';
      notice.textContent = [warning, state.notice].filter(Boolean).join(' ');
    }

    address.addEventListener('input', () => { editing = true; });
    document.querySelector('form').addEventListener('submit', (event) => {
      event.preventDefault();
      const target = address.value;
      editing = false;
      void command('navigate', target);
    });
    for (const name of ['back', 'forward', 'reload', 'keep', 'close']) {
      document.getElementById(name).addEventListener('click', () => {
        editing = false;
        void command(name);
      });
    }
    view.onFocusAddress(() => { address.focus(); address.select(); });
    view.onState(show);
    void command('state').then(show);
  </script>
</body>
</html>`;
}
