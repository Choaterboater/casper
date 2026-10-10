# tmux and iTerm2

This is automatic inside tmux: there is nothing to turn on. Casper never starts tmux itself; it only
notices when you already run it inside tmux (or in iTerm2) and fits itself to it. `/pane off` turns the
side pane off and `/pane on` back on; the choice is saved (in `~/.casper/pane.json`) for every session.

## What Casper does inside tmux

- **Side pane for the busy steps.** On the first step of a task Casper opens one pane to the right of
  its own, when the window is at least 120 columns wide (a split halves it; a narrow window keeps the
  steps under the AI's words, and the pane opens on a later step once the window is wide). It shows each command and file step as it runs, and what the helpers (`delegate`) are
  doing. The main screen keeps the AI's words, the row each group of steps folds into, its boxes, its questions, the
  status row above the prompt and the receipt.
- **View only.** The pane shows a log that only Casper writes. tmux input is off for that pane, so
  nothing typed there (by you or by the AI) goes anywhere. Casper never sends keys to any pane.
- **Closed for you.** Casper closes the pane when you exit, and also when Casper crashes or is killed:
  the pane watches Casper and closes itself within a second once Casper is gone.
  Your other panes and windows are never changed.
- **Title.** The pane title reads `Casper · <project>`. The title you had comes back at exit.
- **Done bell.** When a long task ends or needs you, Casper rings the bell; tmux marks the window.
  In iTerm2 you also get a notice. For that, Casper turns on tmux's passthrough for its own pane
  only, and turns it back off at exit.
- **Colors and keys.** Casper uses the standard terminal colors and key codes that tmux passes
  through as they are. It changes no tmux setting that other panes use.

Secrets are hidden in the pane just like on the main screen, helper goals included. Each step shows
twice there: once as it starts (`• bash · ssh root@build-server …`) and once as it ends (`✓ …`, or
`— not run` for a command Casper refused). Questions, such as `Reach 198.51.100.20 (build-server)?`, always
come on the main screen, never in the pane.

Outside tmux the steps show as live rows under the AI's words, with the status row above the prompt.

## iTerm2 without tmux

On a Mac in iTerm2, Casper can open the same view-only pane as a split next to its own session, through
iTerm2's own scripting. It asks once, before your first task:

```
Show Casper's steps in a split beside this window? (iTerm2 may ask once to let Casper control it.)
  1 No, keep one window
  2 Yes, split when the window is wide
```

The answer is saved; `/pane on` or `/pane off` changes it later. With a split, macOS may ask the first
time whether your terminal may control iTerm2. If you say no there, Casper keeps the steps on its own screen.

## After a dropped SSH

tmux keeps Casper running when your SSH connection drops. To get back to it:

```sh
ssh you@host
tmux attach
```

If you have more than one tmux session, `tmux ls` lists them and `tmux attach -t <name>` picks one.
Casper and its side pane are where you left them.

## What runs in the background: /tasks

`/tasks` shows one numbered list of what Casper keeps running: dev servers, the browser, the debugger,
helpers and checks, each with a plain status and how long it has run. Then it asks:

```
Stop something?
  1 Keep them
  2 Stop 1
  3 Stop 2
  4 Stop all
```

Enter picks 1, which stops nothing. `/tasks stop 2` or `/tasks stop all` stops without the question.
In a one-shot run or a script, `/tasks` lists them, stops nothing and says so.
