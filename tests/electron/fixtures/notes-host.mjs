// Actual SideAppHost + real Notes Worker, without the OS-encrypted Account Store.
// Supplementary integration harness; full browser containment is tested separately.
import { app, BrowserWindow, WebContentsView } from 'electron';
import { createServer } from 'node:http';
import { SideAppHost } from '../../../dist-electron/side-apps.js';
app.setPath('userData', process.env.PRIVATE_BROWSER_E2E_USER_DATA);
void app.whenReady().then(async () => {
  const window = new BrowserWindow({ width: 1200, height: 800, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  await window.loadURL('data:text/html,<title>Notes native integration fixture</title>');
  const server = createServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end('<title>Neighbor webpage fixture</title><textarea aria-label="Webpage reply" style="width:90%;height:200px"></textarea>');

});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const webpage = new WebContentsView({ webPreferences: { partition: 'persist:notes-test-webpage', sandbox: true, contextIsolation: true, nodeIntegration: false } });
window.contentView.addChildView(webpage);
await webpage.webContents.loadURL(`http://127.0.0.1:${server.address().port}/reply`);
const host = new SideAppHost({ window: () => window, packaged: false, openInTab: () => {}, handleShortcut: () => {}, isBlockedRequest: () => false, privacyEvent: () => {}, changed: () => {} });
const layout = () => {
  const [contentWidth, contentHeight] = window.getContentSize();
  webpage.setBounds({ x: 0, y: 122, width: contentWidth - 400, height: contentHeight - 122 });
  host.layout({ insets: { top: 122, right: 400, left: 0, bottom: 0 }, contentWidth, contentHeight, activeApp: 'easynote', suppressed: false });
  host.setBounds('easynote', { x: contentWidth - 400, y: 122, width: 400, height: contentHeight - 122 });
};
globalThis.notesTestHost = host;
layout();
window.on('resize', layout);
window.on('closed', () => { host.closeAll(); server.close(); app.quit(); });

});
