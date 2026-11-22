# Developer patch review

Open the approved local project in VS Code and pair Private Browser Bridge 0.4.8
or later. In **Dev → AI**, preview the debugging evidence and choose **Fix in VS
Code** to hand off the selected evidence. Copy the proposal as a JSON list of
relative file paths and their complete `newText` strings and paste it in
**Proposed file replacements**. The review supports existing text files and
keeps the draft in this session. It opens read-only proposed text beside each
original in VS Code.

Choose **Apply reviewed patch** after inspecting the differences. VS Code shows
the file list and checks the account's workspace grant, the disk contents and
the editor buffers again. Save the resulting editor changes in VS Code. When
the patch is linked to a repeatable local report, **Rerun test after saving**
checks the saved files and repeats that report's exact test.

**Undo patch** shows the file list again and restores the previous editor text
while all changed files still match the applied patch. Save in VS Code if you
want the undo written to disk. Patch review and undo are available for ten
minutes in the current bridge session. Disconnecting clears both.
