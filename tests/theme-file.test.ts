import { expect, test } from "bun:test";
import { DEFAULT_THEME, THEME_ROLES } from "../src/tui/theme";
import { MAX_THEME_FILE_BYTES, parseThemeFile } from "../src/tui/theme-file";

const error = (text: string) => {
  const result = parseThemeFile(text);
  return "error" in result ? result.error : undefined;
};

test("a theme file is a name and colours: YAML or JSON, roles left out take the default's colour", () => {
  const yaml = parseThemeFile('# a pack\'s theme\r\nname: ocean-night\r\ncolors:\r\n  accent: "#3366FF"\r\n  muted: gray\r\n  diffAdded: bright-green\r\n');
  expect(yaml).toEqual({ theme: { name: "ocean-night", colors: { ...DEFAULT_THEME.colors, accent: "#3366ff", muted: "gray", diffAdded: "bright-green" } } });
  const json = parseThemeFile(JSON.stringify({ name: "mono", colors: Object.fromEntries(THEME_ROLES.map((role) => [role, "default"])) }));
  expect("theme" in json && Object.values(json.theme.colors)).toEqual(THEME_ROLES.map(() => "default"));
  expect(Object.isFrozen("theme" in json && json.theme.colors)).toBe(true);
  expect(parseThemeFile("name: bare\ncolors: {}\n")).toEqual({ theme: { name: "bare", colors: DEFAULT_THEME.colors } });
});

test("a hostile theme file is refused with one plain reason: escapes, controls, code, other fields, other values", () => {
  const refusals: Array<[string, string]> = [
    // Escape sequences, raw or spelled out for YAML or JSON to decode.
    ['name: x\ncolors:\n  accent: "\x1b[31m"\n', "can't hold the character U+001B"],
    ['name: x\ncolors:\n  accent: "\\e[2J"\n', "can't hold a backslash"],
    ['{"name": "x", "colors": {"accent": "\\u001b]0;title\\u0007"}}', "can't hold a backslash"],
    ["name: x\ncolors:\n  accent: \x9b31m\n", "U+009B"],
    ["name: x\u202e\ncolors: {}\n", "U+202E"],
    ["name: x\ncolors:\n\taccent: red\n", "U+0009"],
    ["name: x\rcolors: {}\n", "U+000D"],
    ["\0name: x\n", "U+0000"],
    // Invisible, bidi and line-separator characters: every legal key and value is printable ASCII, so nothing else is.
    ['name: x\ncolors:\n  "a b": red\n', "U+2028"],
    ["name: x\ncolors:\n  acc­ent: red\n", "U+00AD"],
    ["name: x​\ncolors: {}\n", "U+200B"],
    ["﻿name: x\ncolors: {}\n", "U+FEFF"],
    ["name: x⁠\ncolors: {}\n", "U+2060"],
    ["name: x\ncolors:\n  accent: red \u{1f600}\n", "U+1F600"],
    ["# café\nname: x\ncolors: {}\n", "U+00E9"],
    // Anything but a name and colours.
    ["name: x\ncolors: {}\ncode: rm -rf ~\n", 'unknown field "code"'],
    ["name: x\ncolors: {}\nextends: default\n", 'unknown field "extends"'],
    ["name: x\ncolors: {}\ninclude: ../../other.yaml\n", 'unknown field "include"'],
    ["name: x\ncolors: {}\n__proto__: {polluted: true}\n", 'unknown field "__proto__"'],
    ['{"name": "x", "colors": {}, "constructor": {"prototype": {}}}', 'unknown field "constructor"'],
    ["name: x\ncolors:\n  background: red\n", 'unknown role "background"'],
    ["name: x\ncolors:\n  __proto__: red\n", 'unknown role "__proto__"'],
    // Values: #rrggbb or a colour name, nothing else.
    ["name: x\ncolors:\n  accent: 38;2;1;2;3\n", "accent must be #rrggbb"],
    ["name: x\ncolors:\n  accent: '#fff'\n", "accent must be #rrggbb"],
    ["name: x\ncolors:\n  accent: 36\n", "accent must be #rrggbb"],
    ["name: x\ncolors:\n  accent: [red]\n", "accent must be #rrggbb"],
    ["name: x\ncolors:\n  accent: {inherit: default}\n", "accent must be #rrggbb"],
    ["name: x\ncolors:\n  accent: #3366ff\n", 'put a #rrggbb colour in quotes'],
    // YAML that builds on itself or names a type: no anchors, aliases, merges or tags.
    ["name: x\ncolors:\n  accent: &a red\n  muted: *a\n", "anchors, aliases or tags"],
    ["name: x\ncolors:\n  <<: {accent: red}\n", 'unknown role "<<"'],
    ["name: x\ncolors:\n  accent: !!binary cmVk\n", "anchors, aliases or tags"],
    ["name: x\ncolors:\n  accent: !include other.yaml\n", "anchors, aliases or tags"],
    // The name follows the skill rule; the file is one mapping.
    ["name: ../../etc\ncolors: {}\n", "name must be 1–64 lowercase letters"],
    ["name: Ocean\ncolors: {}\n", "name must be 1–64 lowercase letters"],
    [`name: ${"a".repeat(65)}\ncolors: {}\n`, "name must be 1–64 lowercase letters"],
    ["name: x\n", "colors is missing"],
    ["name: x\ncolors: [red]\n", "colors must be a mapping"],
    ["- name: x\n", "must be a mapping with name and colors"],
    ["just text", "must be a mapping with name and colors"],
    ["", "must be a mapping with name and colors"],
    ["name: x\ncolors: {}\n---\nname: y\n", "not valid YAML or JSON"],
    ["name: x\nname: y\ncolors: {}\n", "not valid YAML or JSON"],
    ["name: x\ncolors: {accent: red\n", "not valid YAML or JSON"],
  ];
  const wrong = refusals.filter(([text, reason]) => !error(text)?.includes(reason)).map(([text, reason]) => `${JSON.stringify(text)} gave ${JSON.stringify(error(text))}, wanted ${reason}`);
  expect(wrong).toEqual([]);
  // No reason ever carries what it refused back to the screen.
  for (const [text] of refusals) expect(error(text)).not.toMatch(/[\x00-\x1f\x7f-\x9f\xad\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/);
});

test("a theme file over 8 KiB is refused before it is parsed", () => {
  const padding = `# ${"x".repeat(MAX_THEME_FILE_BYTES)}\n`;
  expect(error(`${padding}name: x\ncolors: {}\n`)).toBe("a theme file must be at most 8 KiB");
  // Bytes, not characters: multi-byte text counts in full.
  expect(error(`# ${"é".repeat(MAX_THEME_FILE_BYTES / 2)}\nname: x\ncolors: {}\n`)).toBe("a theme file must be at most 8 KiB");
  expect(error(`# ${"x".repeat(MAX_THEME_FILE_BYTES - 100)}\nname: x\ncolors: {}\n`)).toBeUndefined();
});
