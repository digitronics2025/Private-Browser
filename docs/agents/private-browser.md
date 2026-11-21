# Use Private Browser with Claude Code or Codex

1. Install the Windows build that includes Agent Mode. Open **Browser menu →
   Settings → Open Agents** and turn on **Allow coding agents**.
2. In **Client setup**, copy **Claude Code setup** into PowerShell. For Codex,
   copy the **Codex config.toml** block into `~/.codex/config.toml` and start a
   new Codex session. Settings shows the full path from your installation.
3. Click **Generate pairing code**. Run **Pair Claude Code** or **Pair Codex**
   in PowerShell and enter the eight digits at its private prompt. Generate a
   fresh code when pairing the other client.
4. Start a development server. Try “Open my app at
   `http://localhost:3000` in Private Browser. Take a snapshot, check the
   console for errors, and record the flow as a Playwright test.”
5. Review the first navigation in the **Agent Workspace**. Choose **Allow
   once** or **Allow for this session**. To remember a site, choose **Allow
   once**, then have the agent open the same loaded page in a new Agent tab.
   Choose **Always allow on this site** when offered. The exact origin is
   saved under **Approved origins**. Unreviewed pages still ask before
   opening, and sensitive or high-risk actions still require review.

Each client starts on the **Develop** profile. Add an exact staging origin
under **Paired clients → Approved origins**. Choose **Observe** for read-only
checks, or **Operate** for drive access limited to named origins. Use **Choose
upload folder** if a test requires a local file. Choose **Session length**
and click **Save permissions**. The default **1 hour** requires renewal
after expiry. **8 hours** and **While Private Browser is open** let the
client reconnect without manual renewal. The client card shows the lease
expiry, and the ten-minute idle timeout still applies.

To sign in yourself, click **Take manual control**, enter your credentials,
then click **Return control to agent**. Use a dedicated test account. Press
**Stop** or `Ctrl+Shift+.` to end every session. Use **Resume Agent Mode**
to allow a paired client to reconnect.

Under **Agent Account Spaces**, click **Reset agent space**, then **Clear this
space** to erase its cookies, cache and site data. Use **Revoke client** to
require fresh pairing.

### Lend an existing tab

Right-click the active tab and choose **Let agent use this tab for 15
minutes**, then select a connected client. A banner names the client, and
Private Browser asks you before each page change. Click **Stop** in that
banner or switch tabs to take the page back.

For parallel checks, ask your agent to label each task's tab and keep using
its returned tab ID. Each task can record its own Playwright test.

### Development setup

Run `npm ci`, then `npm run build` and `npm start`. On Windows, the panel
shows copy-ready commands that run the CLI through `node` from the checkout.
Linux development requires Node.js, Electron's encrypted Secret Service
backend and the `secret-tool` executable. Use `node
packages/agent-mcp/dist/cli.js doctor --client codex` to check the setup.
