# Record a fixture workflow

Open the synthetic loopback fixture in Development, select its trusted project
in VS Code, then choose **Developer → Test → Record Flow**. Private Browser
Bridge 0.4.7 opens a fresh Chromium window. Use unique `data-testid` values
made of letters, digits, hyphens or underscores for the buttons, links,
checkboxes and the result. Keep the fixture on its original route.

Perform the actions, choose **Pick expected result**, then select the visible
result and choose **Finish recording**. The recorder skips typed text,
unlabelled controls and interactions it cannot replay. It disconnects service
workers, blocks WebSockets and confines HTTP to read-only requests on the
fixture's own loopback origin. Record only synthetic data.

The recorder replays the actions in another fresh Chromium context. The report
shows the exact action list, the selected result and the skipped count. A replay
that reaches the result can be saved as a Playwright test. **Review and save
generated test…** opens the full source in VS Code before asking permission to
write its exact path. The generated test applies the same network limits.
