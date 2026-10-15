# 13. Changing the project's checks needs its own answer

- **What:** AI edit/write of configured checks or their named scripts asks `Change the test check for this project?`,
  with old → new and No first. Save persists; an existing-command replacement may instead be session-only,
  leaving the file untouched. Both approved command replacements update current-task registries. Session-only is a quiet kept-file note, not a failed edit; further check edits in that task keep the files without another box.
- **Why:** a slow or failing check is not permission to weaken what checks the work.
- **Guard rails:** No, Enter, cancellation or no question channel writes nothing; concurrent saves invalidate
  the preview. Shell mutations targeting checks or copying over their parent folder are directed to native
  edit/write; reading a check or copying it to an unrelated file is not a rewrite. This is a text guard,
  not isolation from opaque scripts. Unrelated settings and user-issued setup flows keep their normal behavior.
- **A finding:** a native configured-check rewrite persists without its answer, or a session-only choice writes
  the file or fails to update the active check command.
