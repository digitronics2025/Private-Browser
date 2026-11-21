# Use Private Browser with Claude Code or Codex

1. Install the Windows build that includes Agent Mode. Open **Browser menu →
   Settings → Open Agents** and turn on **Allow coding agents**.
2. In **Client setup**, copy **Claude Code setup** into PowerShell. For Codex,
   copy the **Codex config.toml** block into `~/.codex/config.toml` and start a
   new Codex session. Settings shows the full path from your installation.
3. Click **Generate pairing code**. Run **Pair Claude Code** or **Pair Codex**
   in PowerShell and enter the eight digits at its private prompt. Generate a
   fresh code when pairing the other client.
4. In **Agent Account Spaces → Edit Work**, add the exact origin of your
   development server and select the paired client under **Client access**.
   Enable **Diagnostics** if you want the fixed loopback checks. Click
   **Save changes** and start the development server. Try “Open my app at
   `http://localhost:3000` in Private Browser. Take a snapshot, check the
   console for errors, and record the flow as a Playwright test.”
5. Review the first navigation in the **Agent Workspace**. Choose **Allow
   once** or keep navigation approved for that origin until the session ends.
   When opening an already-loaded page again on an exact Work origin you listed,
   **Always allow on this site** can remember that navigation choice.

Use **Edit Open Web** to grant a client public browsing in a disposable
partition. The owner signs in only in Work. Unlisted Work pages open in a
signed-out preview as directed by **Other origins**. Choose **Block** to
refuse unlisted sites entirely. Review any subdomain rule before adding it.

Use **Choose folder** in the space editor if a test requires a local file.
Work file tools require a folder grant and the Files option. Downloads stay
in that space and older completed files are removed when its quota is needed.
The Audit log shows actions by space without typed values or page text.

To sign in yourself on a listed Work origin, click **Take manual control**,
enter your credentials, then click **Return control to agent**. Press **Stop**
or `Ctrl+Shift+.` to disconnect. **Resume Agent Mode** permits reconnects
within the existing session. To renew, open **Paired clients → Limits →
Review renewal** and confirm the duration.

To erase cookies, cache and site data for a space, open its editor, select
**Reset agent space**, and confirm **Clear this space**. Downloads stay in
their folder. To require fresh pairing, use **Revoke client** in **Limits**.

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
