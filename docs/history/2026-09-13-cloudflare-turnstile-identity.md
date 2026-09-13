# Cloudflare Turnstile browser identity correction

The 0.5.7 compatibility change removed Electron and application tokens from
remote-view User-Agent strings. That produced a Chrome-looking legacy header
while `navigator.userAgentData` continued to identify the Chromium engine. The
Cloudflare dashboard consequently rejected its login verification step.

Cloudflare's current embedded-browser guidance requires a stable default User
Agent and browser characteristics, and warns that modified identities can break
Challenges. Private Browser now leaves Electron's session identity untouched.
The Electron regression compares the network header, session value and renderer
value, then completes Cloudflare's official always-pass Turnstile test-key flow
inside an isolated Account Space. Production challenges remain deliberately
outside automation because Cloudflare does not support automated browsers for
solving them.

References:

- https://developers.cloudflare.com/turnstile/get-started/mobile-implementation/
- https://developers.cloudflare.com/cloudflare-challenges/reference/supported-browsers/
- https://developers.cloudflare.com/turnstile/troubleshooting/testing/
