# Browser performance checks

The Windows Electron test `profiles a 30-tab window` opens 30 tabs in a
disposable profile and exercises a local favicon, a download and an open menu.
Run it with the same compiled desktop build used by the native test suite.

On an i7-8700 Windows PC with 32 GiB of RAM, the full snapshot was about 17 KiB
and a read took 1.9 ms at the 90th percentile before the change. The download
burst caused 25 full snapshots. After the change, the same fixture sent one
small progress update and no full snapshot during the burst. Individual
download start, interruption and completion still update the full snapshot.
Five same-account favicon reads shared one in-flight fetch. The request key
includes the Account Space.

Native capture latency varied from run to run. An overlapping menu now paints
a neutral backdrop first and uses the still if it arrives during preparation.
The test delays the capture until after the menu has opened and confirms that
`Ctrl+L` still focuses the address bar. It checks behavior and message counts.
Timings are printed for comparison on the same machine.
