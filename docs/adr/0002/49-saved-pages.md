# 49. Saved pages: found and reopened from any folder, in plain words or with one key

Date: 2026-10-31. Status: accepted (merged 2026-11-01 in #560).

**What:** the pages the AI makes (comparisons, dashboards, reports, mock-ups, and diagrams shown as pages) were
already saved, one file a page in `~/.casper/pages/<project-key>/`, but only the folder you were in could list them, the
list had no dates, and the AI could make a page but not open an old one. Now:

- **`/pages` lists every folder's pages**, this folder's first, then the newest: a number, the name, the day it was made
  (`today`, `yesterday`, `Oct 20`) and the folder's name. The row under it (`Next: 1 Open planes-radar · 2 Open …`)
  opens one with a key. `/pages open <name>` and `/pages remove <name>` take a name, or `<folder-key>/<name>` (what
  the row sends) for a page in another folder.
- **At the start**, the row that offers `1 Continue …` also offers `Saved pages (12)` when there are any; with no
  earlier conversation it is `1 Saved pages (12)` on its own. Only Continue claims a `1` typed before the row shows.
- **In plain words**: "show me the radar page from yesterday" works. `casper_page` takes `open`: a page's name, a ref
  or a few words. One match opens it; several, none, or `""` give the AI the list (ref, folder, day; at most 20) to
  pick from or show. The AI's open keeps to **Open pages in the browser** (off: the link only); `/pages open` opens
  whatever it says, as before, since you asked.
- A page from another folder opens on a page server for that folder alone: one server per folder used in the session,
  each on `127.0.0.1`, each stopped when Casper quits.

Storage, names, the page policy and the server's rules are unchanged; nothing moves on disk.

**Why:** the owner: what the AI builds should be saved, named and reopened later, across sessions, in plain words,
with a visible way to list and open them that doesn't rely on a command to remember, "as long as i dont get more and
more prompts". Asked one question at a time, the owner chose: pages and diagrams only (files written into a project,
such as configs, stay where they are); keep the per-folder storage and list across folders, this one first; both plain
words and the start's row with a numbered list; open through Casper's page server in the default browser, the file
itself when no session is running.

**Guard rails:**

- No new question or box: saving stays automatic, the rows only offer keys, and opening a saved page asks nothing.
- Only Casper's own page folders are read: a folder name must be a project key (`<name>-<16 hex>`), and a link, a loose
  file or any other folder under `~/.casper/pages` is skipped. A ref with more than one `/`, `..`, or a name that isn't a
  page name opens nothing. Each server serves one folder only, with the same name rule, policy and host check.
- `open` gives the AI other folders' page names, folder names and days, never a page's contents; it shows the page to
  you in the browser and gives the AI only the link.
- The fixed prompt does not grow: the tool's line dropped "Same name updates" (the guide, sent with the first page,
  says it) to pay for `open`. Measured: 12,340 characters fixed and 344 for `casper_page`, the same as before.

**A finding:** a page served from outside `~/.casper/pages/<project-key>/`; a link or a non-project folder listed or
opened; page contents from another folder sent to the model; a question or box added to saving or opening; the AI's
open opening a browser with **Open pages in the browser** off; or the fixed prompt growing for this.
