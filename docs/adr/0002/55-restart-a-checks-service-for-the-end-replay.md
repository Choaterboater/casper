# 55. The end replay starts a check's own service again; a cancelled dialog is not a failure

Date: 2026-11-02. Status: proposed. Amends 52 (checks follow their service).

## Decision

- **Its own service, started again.** At the end of a task, Casper's replay of a browser check whose own service has
  stopped starts that service again, then replays on it: the model's ad-hoc service by its name and command, or a
  declared one. The check's `notes` say `started <service> again for this replay: it had stopped`. Once the replays
  end, Casper stops what it started, so the model's servers are left as it left them.
- **The same command is the same service.** A check records its ad-hoc service's command and readiness. When Casper
  has let that slot go (more ad-hoc services were started after it), the check follows the ad-hoc service running the
  same command, and the end replay starts that command again if none does.
- **Stale only when that's impossible.** A service whose startup fails is noted (`could not start <service> again:
  …`) and not tried again for the next check; it, or a service Casper no longer keeps, leaves the check to Casper's
  server and decision 52's stale rule as before.
- **The data its check saw.** A check now also records the settings files it ran with (`config/*.yaml`, TOML, INI),
  as it records data files. Before its end replay both are put back, and a check's own server that is running is
  restarted so an app that holds them in memory reads them afresh. After the replays the model's files come back and
  those servers restart again.
- **A cancelled dialog.** Casper still answers Cancel to `confirm` and `prompt` dialogs. A check that fails after that
  never saw what OK does: it is incomplete (`cancelled` on the check), with a reason that says so and how to check it
  instead, starts no repair, and the receipt says `1 not checked, Casper answered Cancel to its confirm dialog: <name>`.
- **A selector that matches several elements** in an assertion is a check written wrong, as a step's already is
  (deliberate choice 7, now for assertions too): a new check is not recorded (the error says how many it matched), and a replay of one is incomplete
  (`writtenWrong`), starts no repair, and the receipt says `1 written wrong: <name> (assertion 1's selector matches 2
  elements)`. As choice 7's guard rail says, a recorded check is never dropped for it.
- **An end replay that can't finish says why.** Deliberate choice 5's guard rail ("a replay past its shared minute leaves the check as it was",
  which the end replay also applied to a replay that threw) now keeps a failure as it was, but no longer keeps a pass as stale with no word why: the check is incomplete
  (`notReplayed`) and the receipt says `not replayed: <name> (<why>)`. Nothing else changes: the replay still never
  asks, and still runs only `local-test` steps.
- The model's own `replay` calls are unchanged: they never start its servers.
- **Stale stays stale.** A failure on a stand-in is compared with how the check last ended on its own server, so a
  check an earlier replay already made stale (the model's repair turn replays it again) is still stale, not failed.

## Why

In three comparison runs (Haiku 5.5, the owner's start-page prompt), two ended exit 2 only because checks recorded
on the model's ad-hoc server were replayed after the model had stopped it: they opened on Casper's server for the
project, which held other settings, and came out stale. Casper knew the service's command all along. The third
ended exit 1 on two checks that were Casper's doing, not the app's:

- `settings: remove the weather widget` clicked Remove, the app asked `confirm()`, and Casper answered Cancel, so the
  widget was never removed. The check could not pass as written, and the app's Remove worked in the shared checks.
- `empty dashboard with default config shows a clear next step` passed when recorded. At the end it replayed on the
  model's server, still running. Casper put the data files back but not the settings, and the app keeps its YAML
  config in memory, so the page showed the widgets earlier replays had installed.

In the first runs with this change, one more run ended exit 1 the same way: the model started six ad-hoc services, Casper
let go of the slot its checks were recorded on, the model started that same command again under a new name, and the
checks fell back to Casper's server. A repair-turn replay there then reported them failed, because the earlier stale
result was taken as the check's last status.

In the next three runs, one ended exit 1 on the model's own check whose assertion selector matched two elements (failing
since it was recorded), and one ended exit 2 on a check whose end replay threw; the receipt said only that it "ran
before a later edit or command".

## Guard rails

- Only Casper's end replays start a service, and only one the check ran on; Casper's own slots are never the AI's.
- A service the replays started is stopped when they end; one already running is left running.
- The command is the one the model started (approved and sandboxed then); starting it again goes through the same
  slot, sandbox and approval hook, as a restart after an edit already does.
- A check that fails after a cancelled dialog, or is written wrong, is never a pass, and never a failure that starts a
  repair. A check that failed stays failed when a later replay can't finish.
- Decision 52 still holds when a service can't start: a check that passed on its own server and fails on Casper's is
  stale; one that already failed there stays failed.

A finding: a service left running that the replays started; a stopped service started by the model's own replay; a
check reported stale while its service could start; a cancelled-dialog check counted as a pass or sent to a repair.
