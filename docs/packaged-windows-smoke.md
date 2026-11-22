# Packaged Windows smoke test

Before uploading the artifact, the Windows job installs the exact candidate
on the disposable Actions runner. The test launches the packaged executable
with a fresh profile and the production Electron fuses. It switches workspaces,
imports a sample Chrome bookmark, unlocks an encrypted test vault, checks
Banking's download restriction, cancels a permitted sample download, pairs a
fixture client over the Windows named pipe, and validates the public update
manifest. The focused Windows tests cover completed downloads and managed
update staging. The packaged test leaves installers unopened.

The job summary lists each executed scenario and the installer SHA-256. The
`packaged-windows-smoke` artifact retains the scenario results and timing for seven days.
