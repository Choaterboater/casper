// Casper's / commands as an ACP client's / menu shows them (available_commands_update), and the ones that can't run
// over ACP (decision 80). A command is ordinary prompt text (`/status`); its output reaches the client as Casper's
// reply in a fenced block (src/acp/updates.ts commandText).

import { loadUserCommands, usableCommands } from "../app/user-commands";
import { COMMAND_REGISTRY, parseCommandLine, takesArguments, type CommandSpec } from "../tui/commands";

/** One entry of ACP's availableCommands: the name without its slash, and what may follow it. */
export interface AcpCommand { name: string; description: string; input?: { hint: string } }

/**
 * Commands left out of the list, with why. Typed, they still run as in a terminal (a refused switch aside, below):
 * leaving them out only keeps the menu to what does something useful here.
 */
export const LEFT_OUT: Readonly<Record<string, string>> = {
  // The app owns it: its own model picker, effort, access chip and export.
  model: "the app owns it", effort: "the app owns it", permissions: "the app owns it", export: "the app owns it",
  // Changes the conversation or folder under the app's chat (acpRefusal refuses them).
  clear: "changes the conversation", resume: "changes the conversation", continue: "changes the conversation", rewind: "changes the conversation",
  branch: "changes the conversation", switch: "changes the conversation", project: "changes the folder",
  // Terminal only: a split, the screen's detail and colours, keys, leaving, the clipboard, the settings screen, sign-ins.
  pane: "terminal only", details: "terminal only", theme: "terminal only", hotkeys: "terminal only", exit: "terminal only", copy: "terminal only",
  settings: "terminal only", login: "terminal only", logout: "terminal only",
  // Does nothing over ACP: the app opened the folder (trust follows Casper's own rules), and receipts' suggestions are
  // a terminal row.
  trust: "does nothing over ACP", suggestions: "does nothing over ACP",
  // The app names its chats from Casper's own title (decision 96); a typed /rename still sends the new name.
  rename: "the app names its chats",
};

/** What may follow a command, for the menu: its hint, or else its first four subcommands. */
export function commandHint(spec: CommandSpec): string | undefined {
  if (!takesArguments(spec)) return undefined;
  if (spec.argumentHint !== undefined) return spec.argumentHint;
  const names = (spec.subcommands ?? []).map((sub) => sub.name);
  return `${names.slice(0, 4).join("|")}${names.length > 4 ? "|…" : ""}`;
}

/** Whether a command file's text takes words ($1, $@, $ARGUMENTS, ${1:-x}, ${@:2}). */
const TAKES_WORDS = /\$(?:\{(?:\d+|@|ARGUMENTS)[:}]|\d|@|ARGUMENTS)/;

/**
 * The commands an ACP client lists: Casper's in the registry's order (none hidden, none LEFT_OUT), then your own from
 * ~/.casper/commands that no Casper command hides. Every word goes through `hide`; a name `hide` would change is left
 * out, since the client would type it back changed.
 */
export function acpCommands(home: string, hide: (text: string) => string): AcpCommand[] {
  const entry = (name: string, description: string, hint: string | undefined): AcpCommand[] =>
    hide(name) !== name ? [] : [{ name, description: hide(description), ...(hint !== undefined ? { input: { hint: hide(hint) } } : {}) }];
  const own = COMMAND_REGISTRY.filter((spec) => !spec.hidden && !Object.hasOwn(LEFT_OUT, spec.name)).flatMap((spec) => entry(spec.name, spec.description, commandHint(spec)));
  const mine = usableCommands(loadUserCommands(home)).flatMap((command) =>
    entry(command.name, command.description, command.argumentHint ?? (TAKES_WORDS.test(command.content) ? "[words]" : undefined)));
  return [...own, ...mine];
}

const CHATS = "but this app keeps its own chats";

/**
 * Why a typed command line is not run over ACP, or undefined when it runs. These would move Casper to another
 * conversation or folder while the app's chat stays where it is, so the two would disagree. Bare /branch and bare
 * /project only show something, so they run.
 */
export function acpRefusal(line: string): string | undefined {
  const parsed = parseCommandLine(line);
  if (!parsed) return undefined;
  const typed = `/${parsed.typed}`;
  switch (parsed.command.name) {
    case "clear": return `${typed} starts a new conversation inside Casper, ${CHATS}: start a new chat in the app. Nothing changed.`;
    case "resume": return `${typed} goes back to another saved conversation inside Casper, ${CHATS}: open that chat from the app's history. Nothing changed.`;
    case "continue": return `${typed} goes back to the most recent other conversation inside Casper, ${CHATS}: open that chat from the app's history. Nothing changed.`;
    case "rewind": return `${typed} goes back to an earlier prompt inside Casper, ${CHATS}: edit or send that message again in the app. Nothing changed.`;
    case "switch": return `${typed} moves Casper to another named conversation, ${CHATS}: start a new chat in the app. Nothing changed.`;
    case "branch": return parsed.args ? `${typed} <name> makes a named conversation and moves Casper there, ${CHATS}: start a new chat in the app (${typed} alone lists them). Nothing changed.` : undefined;
    case "project":
      if (!parsed.args) return undefined;
      return parsed.subcommand?.name === "new"
        ? `${typed} new starts a project in another folder and moves Casper there, but this app opened Casper in this one: make the project, then open its folder in the app. Nothing changed.`
        : `${typed} <name> moves Casper to another folder, but this app opened Casper in this one: open that folder in the app. Nothing changed.`;
    default: return undefined;
  }
}
