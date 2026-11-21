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
   once** or keep navigation approved for that origin until the session ends.

Each client starts on the **Develop** profile. Add an exact staging origin
under **Paired clients → Approved origins**. Choose **Observe** for read-only
checks, or **Operate** for drive access limited to named origins. Use **Choose
upload folder** if a test requires a local file.

To sign in yourself, click **Take manual control**, enter your credentials,
then click **Return control to agent**. Use a dedicated test account. Press
**Stop** or `Ctrl+Shift+.` to end every session. Use **Resume Agent Mode**
to allow a paired client to reconnect.

Under **Agent Account Spaces**, click **Reset agent space**, then **Clear this
space** to erase its cookies, cache and site data. Use **Revoke client** to
require fresh pairing.

### Development setup

Run `npm ci`, then `npm run build` and `npm start`. On Windows, the panel
shows copy-ready commands that run the CLI through `node` from the checkout.
Linux development requires Node.js, Electron's encrypted Secret Service
backend and the `secret-tool` executable. Use `node
packages/agent-mcp/dist/cli.js doctor --client codex` to check the setup.
