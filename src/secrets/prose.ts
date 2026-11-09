import { keepLiterally, KIND_ORDER, replaceSpans, TRUNCATED_MARK, windowedSpans, type SecretKind } from "./patterns";
import { isSecretName } from "./assignments";
import { mayBeLineEnd, SECRET_MARKER, type LiveScrub, type ScrubTextResult } from "./scrub";

/**
 * Secrets written the way people write them in notes, docs and commands, not as KEY=VALUE:
 * "**Password:** X", "pw: X", "password X", "root / X", "login: admin / X", "creds: user / X", user:X@host,
 * a table with a Password column, Proxmox API tokens (user@realm!name=<uuid>, PVEAPIToken=...) and
 * token=<uuid or long hex>. Each rule hides the value only, so the AI still sees what the line is about. Values
 * must look like a secret (a digit or a symbol) where plain words could follow, so ordinary sentences about
 * passwords stay readable.
 */

interface Span { start: number; end: number; kind: SecretKind }

const UUID = String.raw`[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}`;
/** Words that are placeholders or code, never a value; YAML tags that name a value kept elsewhere (`!secret weather_key`). */
const NOT_A_VALUE = /^(?:!secret|!env_var|!include|!vault|str|string|int|bool|none|null|nil|true|false|undefined|required|optional|secret|password|token|changeme|example|xxx+|redacted|hidden|n\/a|na|tbd|todo|unknown|same|none\.?|empty|blank)$/i;

/** A word that looks like a secret, not a plain word: a digit with a letter, a symbol, or a long number. */
function secretLike(value: string): boolean {
  // `secret = !pagination;` in code: a negated name is judged as the name, not as a password with a "!" in it.
  const negated = /^!+([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)[.,;:)\]]*$/.exec(value);
  if (negated) return secretLike(negated[1]!);
  if (value.length < 4 || (value.match(/[A-Za-z0-9]/g)?.length ?? 0) < 3 || /^[<{$%(\["']/.test(value) || /:\/\//.test(value) || /^[/~.]/.test(value)) return false;
  if (NOT_A_VALUE.test(value)) return false;
  return (/\d/.test(value) && /[A-Za-z]/.test(value)) || /[!@#$%^&*+=?~]/.test(value) || /^\d{6,}$/.test(value);
}

/** Any value that was marked as one (bold, backticks, after a colon): only placeholders and code words stay. */
function anyValue(value: string): boolean {
  return value.length >= 3 && !/^[<{$%]/.test(value) && !NOT_A_VALUE.test(value) && !keepLiterally(value) && !/^\*+$/.test(value);
}

/** `pw = re.search(r"..._PASSWORD=(.*)", env)` reads the password from a file: a call in code is not the value. */
const codeCall = (value: string) => /^!*[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*\(/.test(value);

/** A value in a command: 'quoted', "quoted" or one word. The quotes stay; only what is inside is hidden. */
const QUOTED = String.raw`'[^'\n]+'|"[^"\n]+"|[^\s'"]+`;
const unquote = (value: string) => /^(['"]).*\1$/s.test(value) ? value.slice(1, -1) : value;

interface ProseRule { re: RegExp; group: number; kind: SecretKind; accept: (value: string, match: RegExpExecArray) => boolean }

const PASSWORD_WORDS = String.raw`password|passwd|passphrase|pass|pw|secret|api[ _-]?key|api[ _-]?token|token|psk|pre-shared key`;

const RULES: ProseRule[] = [
  // **Password:** X, Password: **X**, pw: `X`, __Token__ = X (markdown around the key or the value).
  { re: new RegExp(String.raw`(?<![\w-])(\*\*|__)?(?:${PASSWORD_WORDS})(\*\*|__)?\s*[:=]\s*(\*\*|__)?\s*(\`{1,3})?([^\s\`*]+)`, "gid"),
    group: 5, kind: "password", accept: (value, match) => {
      const marked = Boolean(match[1] || match[2] || match[3] || match[4]);
      if (!marked && codeCall(value)) return false;
      return marked || /^pw\b/i.test(match[0]) ? anyValue(value.replace(/[.,;)]+$/, "")) : secretLike(value);
    } },
  // password X, password is X, the pw was X: only a value that looks like a secret.
  { re: /(?<![\w-])(?:password|passwd|passphrase|pw)\s+(?:is\s+|was\s+|of\s+|=\s*)?(`?)([^\s`]+)\1/gid, group: 2, kind: "password",
    accept: (value, match) => match[1] === "`" ? anyValue(value) : !codeCall(value) && secretLike(value) },
  // the root password for the lab is X: a few words between, and only a value that looks like a secret.
  { re: /(?<![\w-])(?:password|passwd|pw)\b[^\n.:=`]{1,40}?\s(?:is|was)\s+(`?)([^\s`]+)\1/gid, group: 2, kind: "password",
    accept: (value, match) => match[1] === "`" ? anyValue(value) : secretLike(value) },
  { re: /(?<![\w-])pass\s+([^\s`]+)/gid, group: 1, kind: "password", accept: (value) => secretLike(value) },
  // In commands: sshpass -p X, --password X, --token=X, curl -u user:X, mysql -pX, ipmitool -P X, smbclient -U user%X,
  // echo X | sudo -S, echo user:X | chpasswd.
  { re: new RegExp(String.raw`\bsshpass\s+(?:-[a-zA-Z]\s+)*?-p\s*(${QUOTED})`, "gid"), group: 1, kind: "password", accept: (value) => anyValue(unquote(value)) },
  { re: new RegExp(String.raw`(?<![\w-])--?(?:password|passwd|pass|pw|passphrase|token|api-?key|api-token|auth-token|access-token|secret|client-secret|psk)(?:=|\s+)(${QUOTED})`, "gid"),
    group: 1, kind: "password", accept: (value) => !unquote(value).startsWith("-") && anyValue(unquote(value)) },
  { re: /\b(?:curl|wget)\b[^;&|\n]*?\s(?:-u|--user)(?:\s+|=)?(['"]?)[^\s:'"]+:([^\s'"]+)\1/gid, group: 2, kind: "password", accept: (value) => anyValue(value) },
  { re: new RegExp(String.raw`\b(?:mysql|mariadb|mysqldump|mysqladmin)\b[^;&|\n]*?\s-p(?!\s)(${QUOTED})`, "gid"), group: 1, kind: "password", accept: (value) => anyValue(unquote(value)) },
  { re: new RegExp(String.raw`\bipmitool\b[^;&|\n]*?\s-P\s*(${QUOTED})`, "gid"), group: 1, kind: "password", accept: (value) => anyValue(unquote(value)) },
  // smbclient's -U is upper case: `date -u +%Y-%m-%d` is a date format, not user%password.
  { re: /(?<![\w-])-U\s*(['"]?)[^\s%'"]+%([^\s'"]+)\1/gd, group: 2, kind: "password", accept: (value) => anyValue(value) },
  { re: new RegExp(String.raw`\b(?:echo|printf)\s+(?:-\w+\s+)?(${QUOTED})\s*\|\s*sudo\b[^|;&\n]*?\s-\w*S\b`, "gid"), group: 1, kind: "password", accept: (value) => anyValue(unquote(value)) },
  { re: /\b(?:echo|printf)\s+(?:-\w+\s+)?(['"]?)[\w.-]+:([^\s'"]+)\1\s*\|\s*(?:sudo\s+)?chpasswd\b/gid, group: 2, kind: "password", accept: (value) => anyValue(value) },
  // login: admin / X, creds: user / X, username/password: admin / X, sign-in root / X. The word stands alone: a
  // file or branch name with it inside (tests/login-ask.test.ts tests/x.ts, origin/fix/login-expired origin/fix/y) is not.
  { re: /(?<![\w./-])(?:login|logon|log-in|creds?|credentials?|sign[- ]?in|account|user(?:name)?\s*\/\s*pass(?:word)?|u\/p)(?![\w./-])[^\n/]{0,30}?(?:[:=-]\s*|\s)(`?)[\w.@\\-]+\1\s*\/\s*(`?)([^\s`]+)\2/gid,
    group: 3, kind: "password", accept: (value) => anyValue(value.replace(/[.,;)]+$/, "")) },
  // root / X, admin / X (spaces around the slash; a path has none).
  // Also root@pam / X (a Proxmox login with its realm) and **root** / **X** (markdown bold).
  { re: /(?<![/\w.-])(?:\*\*|__)?(?:root|admin|administrator|ubuntu|debian|pi|centos|ec2-user|operator|netadmin|cisco|juniper|aruba|manager|superuser|vagrant|support)(?:@[\w.-]+)?(?:\*\*|__)?\s+\/\s+(?:\*\*|__)?(`?)([^\s`*]+)\1/gid,
    group: 2, kind: "password", accept: (value) => anyValue(value.replace(/[.,;)]+$/, "")) },
  // user:X@host with no scheme (a URL with one is handled by scrubUrlPasswords).
  { re: /(?<![\w/:.@%-])([A-Za-z0-9._-]{1,64}):([^\s@/:'"`]{3,})@((?:\d{1,3}\.){3}\d{1,3}|[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+|localhost)\b/gid,
    group: 2, kind: "password", accept: (value, match) => !/^(?:mailto|email|e-mail|contact|from|to|cc|bcc|reply-to|author|by|at)$/i.test(match[1]!) && anyValue(value) && !/^\$\{?\w+\}?$/.test(value) },
  // Proxmox API tokens: root@pam!sampleapp=<uuid>, PVEAPIToken=user@realm!name=<uuid>.
  // Starts only at the start of a word: without the lookbehind, a long word with no "@" in it was retried from every
  // letter, and a 16 KB line took half a second.
  { re: new RegExp(String.raw`(?<![\w.-])[\w.-]+@[\w.-]+![\w.-]+\s*[=:]\s*(${UUID})`, "gid"), group: 1, kind: "key", accept: () => true },
  { re: new RegExp(String.raw`![\w.-]+=(${UUID})`, "gid"), group: 1, kind: "key", accept: () => true },
  // A uuid later on a line about a token or secret: "PVE token: root@pam!sampleapp 3f1c…" (the id is a name; the uuid
  // is the secret).
  { re: new RegExp(String.raw`(?:\b(?:tokens?|secrets?|api[ _-]?keys?)\b(?!\s+ids?\b)|![\w.-]+)[^\n]{0,80}?(?<![\w-])(${UUID})(?![\w-])`, "gid"), group: 1, kind: "key", accept: () => true },
  { re: /\bPVEAPIToken\s*=\s*[^\s'"=]+=([^\s'"]+)/gid, group: 1, kind: "key", accept: (value) => anyValue(value) },
  // token=<uuid or long hex>, api_secret: <uuid> (not token_id, which names a token). The regex takes the whole name,
  // starting where the name starts, and tokenName() checks it, so a long name is read once, not from every letter.
  // The name is taken whole, with no backing up into it (a match needs all of it); the value is only looked at, not
  // taken, so a name tokenName() turns down does not hide the next name from the search.
  { re: new RegExp(String.raw`(?<![\w-])(?=([\w-]+))\1(?=["']?\s*[=:]\s*["']?(${UUID}|[0-9a-fA-F]{32,})\b)`, "gid"),
    group: 2, kind: "key", accept: (_value, match) => tokenName(match[1]!) },
  // A GitHub token anywhere (ghp_, gho_, ghu_, ghs_, ghr_, github_pat_): git and gh may run outside the sandbox with your
  // login, so one that shows up in their output is hidden even with no name in front.
  { re: /(?<![\w])(gh[pousr]_[A-Za-z0-9]{36,251}|github_pat_[A-Za-z0-9_]{22,251})(?![\w])/gd, group: 1, kind: "key", accept: () => true },
  // Base64 of a JSON object ("eyJ" is `{"`) anywhere: a Cloudflare tunnel token (eyJhIjoi…), a JWT's parts, a cloud
  // login's JSON blob. Long enough that no word or name is one.
  { re: /(?<![A-Za-z0-9+/_=-])(eyJ[A-Za-z0-9+/_-]{30,}={0,2}(?:\.[A-Za-z0-9+/_-]{8,}={0,2}){0,2})(?![A-Za-z0-9+/_=-])/gd, group: 1, kind: "key", accept: () => true },
  // The rest of a token a paste broke with a space (--token eyJhIjoi…xyz MDAwMDAw…): the next long word, when it holds
  // letters and digits.
  { re: /(?<![\w-])--?(?:token|api-?key|api-token|auth-token|access-token|secret|client-secret)(?:=|\s+)[^\s'"]{16,}[ \t]+([A-Za-z0-9+_][A-Za-z0-9+/_-]{15,}={0,2})(?!\S)/gid,
    group: 1, kind: "key", accept: (value) => /\d/.test(value) && /[A-Za-z]/.test(value) },
];

const TOKEN_ID = /token[-_]?id\b/gi;
const TOKEN_WORD = /token|secret|apikey|api_key|api-key/i;

/**
 * Whether the name before token=<uuid> marks a secret. The rule used to start at any word start inside the name and
 * skip a start that had token_id after it, so a name counts when, from its first word start after the last
 * token_id, it still holds token, secret or api key.
 */
function tokenName(name: string): boolean {
  let from = 0;
  for (const match of name.matchAll(TOKEN_ID)) from = match.index + 1;
  for (let at = from; at < name.length; at++) {
    const word = /\w/.test(name[at]!);
    if (word !== (at > 0 && /\w/.test(name[at - 1]!))) return TOKEN_WORD.test(name.slice(at));
  }
  return false;
}

/** Table headers whose column holds secrets. */
const SECRET_HEADER = /^(?:passwords?|passwd|pass|pw|pwd|secrets?|tokens?|api ?keys?|api ?tokens?|psk|pre-shared keys?|credentials?|creds|passphrases?|keys?|community)$/i;
const BAR = /[|│┃║]/g;
const TABLE_ROW = /^\s*[|│┃║]/;
/** A rule between a table's lines (|---|---|, +---+---+, ├──┼──┤, ╞══╪══╡, ====): the table goes on below it. */
const TABLE_RULE = /^(?=.*\S)[\s|:+=\-\u2500-\u257F]+$/;
/** A table's top or bottom edge: a rule with no bar at its start (+---+---+, └──┴──┘, ┌──┬──┐). */
const edge = (line: string) => TABLE_RULE.test(line) && !TABLE_ROW.test(line);
/** A rule with no bar or cross (a line of dashes or =): right under a header it is the header's rule; anywhere else it ends the table. */
const BARE_RULE = /^(?=.*[-=─━═])[\s\-=─━═]+$/;
/** Whether a row's last cell ends in a bar. */
const closed = (line: string) => /[|│┃║]/.test(line.trimEnd().slice(-1));
/** Markdown's rule under its header (|---|---|): it is never drawn between rows. */
const MARKDOWN_RULE = /^\s*\|[\s|:]*-[\s|:-]*$/;
/** A rule drawn with = ═ ━, as under a grid's or rich's header. */
const HEADER_RULE = /[=═━]/;
/** A box's top or bottom edge (┏━━┳━━┓, ╚══╩══╝): never the rule under a header. */
const BOX_EDGE = /^\s*[┌┍┎┏╒╓╔╭└┕┖┗╘╙╚╰]/;
/**
 * A setting a secret-named row holds (password_require_current OFF, password_history 1440): ON or OFF, Y or N, yes or
 * no, true or false, enabled or disabled, a whole number of up to five digits, or a date with or without a time.
 */
const SETTING = /^(?:on|off|yes|no|true|false|enabled|disabled|[yn]|\d{1,5}|\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?)$/i;
/** psql's rule under its header (----+----, ────┼────): its rows have no bar at either end. A CR may end the line. */
const OPEN_RULE = /^[-─]+(?:[+┼][-─]+)+\s*$/;
const cellText = (cell: string) => cell.trim().replace(/^[*_`]+|[*_`]+$/g, "").trim();
const marks = (line: string, mark: RegExp) => [...line.matchAll(mark)].map((match) => match.index);

interface Cell { start: number; end: number; text: string }

/** The cells between a row's bars, with their start and end in the line. */
function cellsAt(line: string, bars: number[]): Cell[] {
  const out: Cell[] = [];
  for (let index = 0; index + 1 < bars.length; index++) {
    const raw = line.slice(bars[index]! + 1, bars[index + 1]!);
    const lead = raw.length - raw.trimStart().length;
    const text = raw.trim();
    out.push({ start: bars[index]! + 1 + lead, end: bars[index]! + 1 + lead + text.length, text });
  }
  return out;
}

/**
 * The cells of a table row. `open`: the line's ends are cell edges too. A row of two bars or more with text after its
 * last bar (Markdown may leave the last bar out) has that text as a cell.
 */
function cells(line: string, open = false): Cell[] {
  const found = marks(line, BAR);
  return cellsAt(line, open ? [-1, ...found, line.length] : found.length > 1 && !closed(line) ? [...found, line.length] : found);
}

const secretHeader = (row: Cell[]) => row.some((cell) => SECRET_HEADER.test(cellText(cell.text)));

/** A header of two columns, the second named value: the first names the rows (key, setting, name ...). */
const keyValueHeader = (row: Cell[]) => row.length === 2 && /^values?$/i.test(cellText(row[1]!.text));

/**
 * The columns a header row names as secret. A key column stays where it names the rows (a header of just "key" and
 * "value") or an index (mysql's EXPLAIN, with possible_keys or key_len, and DESCRIBE, with Field and Type).
 */
function secretColumns(row: Cell[]): number[] {
  const names = row.map((cell) => cellText(cell.text));
  const has = (name: RegExp) => names.some((cell) => name.test(cell));
  const keepKey = (keyValueHeader(row) && has(/^keys?$/i)) || has(/^(?:possible_keys|key_len)$/i) || (has(/^field$/i) && has(/^type$/i));
  return names.flatMap((name, at) => SECRET_HEADER.test(name) && !(keepKey && /^keys?$/i.test(name)) ? [at] : []);
}

/** The rule hits in one line (or one window of a long line). */
function ruleSpans(line: string): Span[] {
  const spans: Span[] = [];
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    for (let match = rule.re.exec(line); match; match = rule.re.exec(line)) {
      const value = match[rule.group];
      const at = match.indices?.[rule.group];
      if (!value || !at || value.includes(SECRET_MARKER) || keepLiterally(value)) continue;
      if (!rule.accept(value, match)) continue;
      let start = at[0];
      let end = at[1];
      if (/^(['"]).+\1$/s.test(value)) { start++; end--; }
      // Trailing sentence punctuation is not part of the value.
      const trail = /[.,;:)\]]+$/.exec(value);
      if (trail && trail[0].length < value.length && !/^['"]/.test(value)) end -= trail[0].length;
      spans.push({ start, end, kind: rule.kind });
    }
  }
  return spans;
}

/** A key and value row ("| password | X |", "│ value │ <uuid> │" after pveum's token add): the cell after a secret name. */
function keyValueSpans(row: Cell[], tokenTable: boolean, named: (key: string, at: number, value: string) => boolean, rest?: number): Span[] {
  const spans: Span[] = [];
  for (let at = 0; at + 1 < row.length; at++) {
    const key = cellText(row[at]!.text).toLowerCase();
    const next = row[at + 1]!;
    if ((SECRET_HEADER.test(key) || (tokenTable && key === "value") || named(key, at, cellText(next.text))) && anyValue(cellText(next.text)) && !next.text.includes(SECRET_MARKER)) {
      spans.push({ start: next.start, end: rest ?? next.end, kind: key === "value" ? "key" : "password" });
    }
  }
  return spans;
}

/** The cells of a row under the secret columns. */
function columnSpans(row: Cell[], columns: number[] | "all" | undefined): Span[] {
  const spans: Span[] = [];
  for (const column of columns === "all" ? row.keys() : columns ?? []) {
    const cell = row[column];
    if (cell && anyValue(cellText(cell.text)) && !cell.text.includes(SECRET_MARKER)) spans.push({ start: cell.start, end: cell.end, kind: "password" });
  }
  return spans;
}

/** A row from its first cell to its last, when a cell holds a value: live (decision 98), with its header out of view,
 * any of it may be a secret column's, and a bar inside a value may have moved the cells after it. */
function wholeRow(row: Cell[]): Span[] {
  const filled = row.filter((cell) => cell.text);
  // Any cell, short or a placeholder too: the final's rest-of-row span (a row under a header with no last bar) checks none.
  return filled.length ? [{ start: filled[0]!.start, end: filled.at(-1)!.end, kind: "password" }] : [];
}

/**
 * The first way of reading tables, kept as it was: a row of bars with a secret word names the secret columns, and any
 * line that is not a row (a rule such as +---+ or ├──┼──┤ too) ends the table. What it hides stays hidden.
 */
function plainTableSpans(lines: string[], tokenTable: boolean, live?: LiveScrub): Span[][] {
  const out: Span[][] = lines.map(() => []);
  // Live (decision 98): after a break (the start when cut, or a truncated mark) the header may be gone, so every cell
  // of a row is read as a secret column's.
  let columns: number[] | "all" | undefined = live?.cut ? "all" : undefined;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (live && TRUNCATED_MARK.test(line)) { columns = "all"; continue; }
    // A cut text's first line, or the line after a truncated mark, may be the end of a table row.
    if (!/^\s*[|│┃]/.test(line)) { if (!mayBeLineEnd(lines, index, live)) columns = undefined; continue; }
    const row = cellsAt(line, marks(line, /[|│┃]/g));
    if (/^[\s|│┃:\-─═╞╪╡├┼┤+]+$/.test(line)) continue;
    if (!columns && secretHeader(row)) { columns = row.flatMap((cell, at) => SECRET_HEADER.test(cellText(cell.text)) ? [at] : []); continue; }
    out[index]!.push(...columnSpans(row, columns), ...keyValueSpans(row, tokenTable, () => false));
  }
  return out;
}

/**
 * Tables read through their rule lines: mysql's, psql's, rich's and tabulate's grids, a key and value table, a bar
 * inside a value, and a table printed straight after another.
 */
function ruledTableSpans(lines: string[], tokenTable: boolean, live?: LiveScrub): Span[][] {
  const out: Span[][] = lines.map(() => []);
  // Live (decision 98): after a break (the start when cut, or a truncated mark) the lines may be a table's rows under a
  // header that is gone, past rule lines too, and psql's have no bar at their start. Until a line with no bar, every row
  // and every line with a bar after its start is held whole (wholeRow): one that reads as a header too, since it may be
  // a key and value table's row (║ password ║ x ║).
  let maybe = live?.cut === true;
  let columns: number[] | undefined;
  // How many cells the header has: a row with more holds a bar inside a value (psql does not escape one).
  let width = 0;
  // psql's table: known by the rule under its header, and read until a line with no bar.
  let open = false;
  // A key and value table: a row whose name holds a secret (api_key, Secret Key) hides its value.
  let keyValue = false;
  // The header's line, and whether the rule under it starts with a bar (Markdown's |---|).
  let headerAt = -1;
  let barRules = false;
  // Where the header's bars and the crosses of the rule under it are, and whether the header has no last bar (then a
  // bar inside a value need not make a row longer).
  let headerBars = "";
  let ruleCrosses = "";
  let headerOpen = false;
  const crosses = (rule: string) => marks(rule, /[^\s\-=:─━═]/g).join();
  const end = () => { columns = undefined; open = false; keyValue = false; headerAt = -1; barRules = false; };
  const header = (row: Cell[], at: number, psqlRule: boolean) => {
    const line = lines[at]!;
    columns = secretColumns(row); width = row.length; open = psqlRule; keyValue = keyValueHeader(row); headerAt = at; barRules = false;
    headerBars = marks(line, BAR).join(); ruleCrosses = ""; headerOpen = !psqlRule && !closed(line);
  };
  /**
   * Whether a row read inside a table is the header of a new one printed straight after it: the line below is
   * Markdown's header rule or a rule of = ═ ━. When a rule is also the line above, the row is a new header only if the
   * rule below has its crosses neither under this table's header bars nor where the rule under that header has them:
   * rich's Markdown box with lines, heavy_grid and double_grid draw that rule between their own rows too, and a wide
   * letter in the header moves its bars in the text. A box's edge or a line of = alone does not start a table.
   */
  const startsTable = (rule: string, above: string) => {
    if (BARE_RULE.test(rule) || BOX_EDGE.test(rule) || !(MARKDOWN_RULE.test(rule) || (TABLE_RULE.test(rule) && HEADER_RULE.test(rule)))) return false;
    const at = crosses(rule);
    return !TABLE_RULE.test(above) || (at !== headerBars && at !== ruleCrosses);
  };
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const before = lines[index - 1] ?? "";
    if (live && TRUNCATED_MARK.test(line)) { end(); maybe = true; continue; }
    // The bars of psql's header sit right above the crosses of its rule.
    const psql: Cell[] = !columns && OPEN_RULE.test(line) && marks(before, BAR).join() === marks(line, /[+┼]/g).join() ? cells(before, true) : [];
    if (secretHeader(psql) || keyValueHeader(psql)) header(psql, index - 1, true);
    else if (TABLE_RULE.test(line)) {
      const under = headerAt >= 0 && index === headerAt + 1;
      if (under) { barRules = TABLE_ROW.test(line); ruleCrosses = crosses(line); }
      // A bottom edge and then a top edge, a bare rule below the rows (print('-' * 40) between two tables), or a
      // grid's edge below Markdown rows: the next table is read by its own header.
      if ((edge(line) && edge(before)) || (BARE_RULE.test(line) && !under) || (barRules && !under && edge(line))) end();
    } else if (open ? line.search(BAR) >= 0 : TABLE_ROW.test(line)) {
      const row = cells(line, open);
      if (maybe) { out[index]!.push(...wholeRow(row)); continue; }
      if ((!columns || (!open && startsTable(lines[index + 1] ?? "", before))) && (secretHeader(row) || keyValueHeader(row))) { header(row, index, false); continue; }
      // A row longer than its header: the bar inside a value moved the cells after it, so the row goes from its first
      // secret cell to its end. So does a row with no last bar (Markdown may leave it out): a bar inside a value need
      // not make that row longer, nor does a row under a header with no last bar.
      const rest = columns && row.length && (row.length > width || (!open && (!closed(line) || headerOpen))) ? row.at(-1)!.end : undefined;
      const first = rest === undefined ? undefined : (columns ?? []).find((column) => row[column]);
      if (first !== undefined) out[index]!.push({ start: row[first]!.start, end: rest!, kind: "password" });
      else out[index]!.push(...columnSpans(row, columns));
      // Under a key and value header any secret name counts: api_key, db_password, "Secret Key", unless it holds a
      // setting (OFF, 1440).
      out[index]!.push(...keyValueSpans(row, tokenTable, (key, at, value) => keyValue && at === 0 && isSecretName(key) && !SETTING.test(value), rest));
    } else if (maybe && line.search(BAR) > 0) out[index]!.push(...wholeRow(cells(line, true)));
    else {
      end();
      // A cut text's first line, or the line after a truncated mark, may be the end of a row.
      if (!mayBeLineEnd(lines, index, live)) maybe = false;
    }
  }
  return out;
}

/**
 * Hide the prose, table and token forms above. A table is read two ways, the first way Casper read tables and the way
 * that follows their rule lines, and a cell either way hides stays hidden. `live`: a running command's latest lines
 * (decision 98), read in the strictest state a line out of view could set: "value" rows and keys read as a token's
 * (pveum's output says "tokenid" somewhere), and after a break a table's header read as gone (both readings above).
 */
export function scrubProseSecrets(text: string, options: { live?: LiveScrub } = {}): ScrubTextResult {
  const lines = text.split("\n");
  const kinds = new Set<SecretKind>();
  const tokenTable = options.live !== undefined || /tokenid/i.test(text);
  const plain = plainTableSpans(lines, tokenTable, options.live);
  const ruled = ruledTableSpans(lines, tokenTable, options.live);
  let hidden = 0;
  const shown = lines.map((line, index) => {
    const spans: Span[] = [...windowedSpans(line, ruleSpans), ...plain[index]!, ...ruled[index]!];
    if (tokenTable) {
      // pveum's --output-format json or yaml: "value": "<uuid>", value: <uuid>.
      const json = new RegExp(String.raw`"?\bvalue"?\s*:\s*"?(${UUID})`, "gd");
      for (let match = json.exec(line); match; match = json.exec(line)) spans.push({ start: match.indices![1]![0], end: match.indices![1]![1], kind: "key" });
    }
    if (!spans.length) return line;
    const sorted = spans.sort((a, b) => a.start - b.start || b.end - a.end);
    const merged: Span[] = [];
    for (const span of sorted) {
      const last = merged.at(-1);
      if (last && span.start < last.end) { last.end = Math.max(last.end, span.end); continue; }
      merged.push({ ...span });
    }
    for (const span of merged) kinds.add(span.kind);
    hidden += merged.length;
    return replaceSpans(line, merged, SECRET_MARKER);
  });
  return { text: hidden ? shown.join("\n") : text, hidden, kinds: KIND_ORDER.filter((kind) => kinds.has(kind)) };
}
