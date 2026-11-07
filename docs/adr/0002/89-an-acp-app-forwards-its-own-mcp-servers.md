# 89. An ACP app forwards its own MCP servers

Date: 2026-11-07. Status: proposed. Extends 76 (Casper speaks ACP), 77 and 81, and changes 77's guard rail "A stdio
server starts in your home folder". An app may hand Casper more than its own bridge: the MCP servers a person set up
in the app's own settings, each with its folder and its keys. Under 77 every server the app listed could pin tools and
heard each call's step, a stdio one always started in your home folder, and a key a server echoed in a link was not
hidden. An app that reopens Casper by itself also starts it with its own `--model`, so a loaded conversation went on
with that model, not its own.

## Decision

- **The app's own server.** A server whose entry carries `_meta: { "casper/clientAsks": true }` (a loopback http one or
  a stdio one, as in 77) is the app's own, whatever `acp_mcp` says. Only that server may pin tools
  (`casper/pin`) and only a call to it carries `casper/acpToolCallId`. Another server the app forwards is ranked as
  any server is, and never hears which step a call is. Whether Casper's change box asks stays 77's rule:
  `casper/clientAsks` with `acp_mcp: on`.
- **`casper/cwd`.** A stdio entry's `_meta: { "casper/cwd": "/absolute/folder" }` is the folder it starts in. A
  relative path, `~/...`, `${PROJECT_ROOT}` or a value that is not a string is refused with the fixed note
  `cwd must be an absolute path`, and no value is shown. With none it starts in your home folder, as before.
- **URL-encoded hiding.** Each header and env value the app gives, and the credential after its scheme, is also hidden
  in its URL-encoded form when that differs, so a token a server puts into a link is hidden as well.
- **A load goes on with the conversation's model.** On `session/load`, the model and effort the conversation was on
  before the run's `--model` and `--effort` are put back for that session only, when they differ from the current
  ones and the model is still one of yours. They are never saved as the default. When they can't be put back, the
  current ones stay and stderr says why, in the runtime's words when it refused.
- No new `acp_mcp` value: the app's own switches decide which servers it forwards.

## Guard rails

- `casper/cwd` is taken as an absolute path only: never read against the project or Casper's own folder. A folder the
  app names is the app's choice, as the program it names is. Everything else of 77 stays: memory only, `acp-` names
  that never shadow a file's, the URL, name and variable rules, at most 8.
- Pins and the step id are for the app's own server only, so a server the app passes on from elsewhere can't push its
  tools ahead of yours or follow Casper's steps.
- The restored model is set with `persist: false`; your saved default, and the app's start model for a new session,
  stay as they were. A `session/new` is unchanged.

## A finding

A forwarded server that pins tools or sees a step id without `casper/clientAsks`, a `casper/cwd` that is not
absolute starting a server, a URL-encoded value that shows, or a load that changes the saved default.
