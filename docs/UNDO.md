# Undo, diff and saved receipts

Casper keeps a copy of your folder before and after each task, so you can see what a task changed and put it
back. This costs no tokens: no model is asked.

## After a task

The receipt of a task that changed files ends with a row:

```
✓ Verified · test passed · changed app.py, tests/test_app.py
Next: 1 Show diff · 2 Undo
```

Type `1` on the empty prompt to see the task's diff, or `2` to undo it. 1 only shows something, so a
stray `1` never undoes a task. Enter alone does nothing, and anything
else you type is simply your next request. The row is gone once you type something else.

A one-shot run ends with the commands instead:

```
Undo: casper /undo 12 · Diff: casper /diff 12
```

## Commands

| Command | What it does |
|---|---|
| `/undo` | Puts back the files of the newest task in this folder that can be undone. |
| `/undo 12` | The same for task 12. |
| `/redo` | Puts the files of the newest undone task back the way that task left them. |
| `/diff` | The newest task's changes (a patch), also in a folder that is not a git repository. With no task yet, git's view (`git diff HEAD`). |
| `/diff 12` | Task 12's changes. |
| `/diff list` | Pick one of your recent tasks by number. While a task runs it prints the list instead; `/diff <n>` shows one. |
| `/receipt` | The last receipt, also after Casper restarts. |
| `/receipt 12` | Receipt 12, headed "Task 12 · 14:02 · fix the login bug". |
| `/receipt list` | The last 10 receipts: number, time, first line and request. |

On the command line: `casper /undo`, `casper /redo`, `casper /diff 12`, `casper /receipt list`. There, a
task number that doesn't exist, a bad number, or an undo Casper refuses exits 1 with the reason. With no
commits yet and no task, `/diff` lists the files and says there is nothing to compare with.

## The rules

- **Only this task's files.** Undo compares the copy from before the task with the copy from when its receipt
  was written. Your own earlier edits are not part of it. A file you save in your editor while the task runs
  is in the task's copy too, so undo puts it back as well; the undo line names every file, and `/redo` returns them.
- **Never over your later work.** A file that changed after the task (by you, your editor or a later task) is
  left as it is. In a session Casper asks:

  ```
  notes.py changed after task 12.
    1 Cancel · nothing is changed
    2 Undo the other 2 files · the files you changed since stay as they are
  ```

  Enter picks 1, which changes nothing. A one-shot `casper /undo` changes nothing and exits 1:
  "notes.py changed after task 12, so Casper left everything as it is."
- **Undo can be undone.** Just before undoing, Casper copies the files once more, so `/redo` (or `1` on the
  row after an undo) puts them back.
- **Files it creates, it may remove.** A file the task added is removed; a file the task did not create is never
  deleted. A file that was already there but had no copy (git ignored it then, it was over 8 MB, or it was inside
  a nested repository) is never deleted, even if the task made it one Casper copies. A folder is removed only
  when it is empty and did not exist before.
- **Links are never followed.** A link is put back or removed as a link. If the task replaced a folder with a
  link, the link is removed and a real folder comes back; nothing is written or removed outside your folder.
- **The conversation.** If nothing was said since the task, in the same conversation, Casper rewinds the
  conversation to before the task ("Conversation rewound to before task 12"). Otherwise it keeps the
  conversation and adds one short note telling the model which files were put back. A one-shot
  `casper /undo` changes no conversation.
- **Your settings.** Saving a test command from the receipt row ("Remember uv run pytest as this project's test
  command") gets its own number, and `/undo` takes it back.

## What undo can't put back

The receipt names these files when the task's own tools edited them, or when they changed between the two copies;
a file changed only by a shell command that git ignores is not named:

- files git ignores, dependency folders (`node_modules`, `.venv`), caches and build folders (`.next`,
  `__pycache__`, and the like);
- Casper's `.casper` folder, except `.casper/project.yaml`, which is copied and goes back like any project file;
- secret files (`.env`, keys, credentials, the list in [SECRETS.md](SECRETS.md)): Casper keeps no copy of them;
- files over 8 MB;
- the contents of nested repositories and submodules;
- files outside this folder;
- anything changed through an MCP server or on a network device ("Undo only puts back files in this folder; it
  can't undo changes made through <server>");
- Git LFS files are kept as the file on disk (the real content), not as LFS pointers.

When undo can't be offered at all, the receipt says why on one line:

```
• Undo not available: git is not installed
• Undo not available: this folder has more than 20,000 files
• Undo not available: Casper could not save a copy (<reason>)
```

Casper checks each file again just before putting it back, so a file you saved while Casper asked is left as
you saved it. An editor that saves in the same instant can still lose that save.

On Windows, undo needs git on PATH (Git for Windows). Putting back a symbolic link or a file's run bit
has not been tried on Windows yet.

## Where the copies live

`~/.casper/projects/<project>-<id>/undo.git` holds the copies and `receipts/<n>.json` the receipts. Both
folders are private to you (0700), and each receipt file is 0600. `/status` shows how much disk the copies take. Casper runs git there with no system or global git settings, no
hooks and no project filters, so your repository's `.git`, its hooks and its settings are never changed; only its
`.git/info/exclude` list is read, so a file your repository ignores is not copied. The newest 100 tasks are kept. Every file in the folder that git does not ignore and that is not a secret file
is copied there, including files that are not committed (and every such file in a folder that is not a git
repository), so treat `~/.casper` like the folder itself.

Saved receipts hold no check output, and secrets in them are shown as `<redacted>`, like the JSON receipt.

## JSON

The `receipt` event has `task` (the receipt number) and `undo` (`{ "available", "reason" }`). See
[SCRIPTING.md](SCRIPTING.md).

## Credits

The copy design is adapted from OpenCode's snapshots (MIT) and the undo rules follow Aider's design (Apache-2.0);
see THIRD_PARTY_NOTICES.txt.
