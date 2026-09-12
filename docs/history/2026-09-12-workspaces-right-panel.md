# Workspaces moved to the right panel

Removed the permanent 74 px workspace rail from the left edge. The same
workspace buttons, protected-space lock state, active-space colour and personal
shortcut now appear as a horizontal switcher at the top of the existing right
panel.

The webpage and home dashboard now extend to the left window edge. Renderer CSS,
the layout IPC payload and the Electron startup layout all use the same `left: 0`
geometry, with a regression test covering the handshake.
