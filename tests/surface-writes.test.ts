import { expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { TerminalSurface } from "../src/tui/surface";

/** The MCP writes badge and ctrl+o on the rich surface. */
function makeSurface() {
  const input = new PassThrough();
  const surface = new TerminalSurface({
    input, output: { write: () => {}, columns: 80, rows: 24 }, color: false, onEOF: () => {},
  }, () => {}, () => {});
  return { surface, input };
}

test("the WRITES badge leads the footer and is never cut off, even 30 columns wide or while waiting for you", async () => {
  const { surface } = makeSurface();
  try {
    surface.start();
    surface.setStatus("project/main │ provider/model · effort high │ ctx 12% │ idle", process.cwd());
    expect(surface.footerLine(80)).not.toContain("WRITES");
    surface.setBadge("WRITES: aruba-central · Ctrl+O");
    expect(surface.footerLine(80)).toStartWith("WRITES: aruba-central · Ctrl+O │ project/main");
    expect(surface.footerLine(30)).toContain("WRITES");
    expect(surface.footerLine(30)).toContain("Ctrl+O");
    const answer = surface.approve("Run it?\n", "Make this change?", [{ label: "No" }, { label: "Yes, this once" }]);
    expect(surface.footerLine(80)).toStartWith("WRITES: aruba-central · Ctrl+O │ ? waiting for you");
    surface.setBadge(undefined);
    expect(surface.footerLine(80)).not.toContain("WRITES");
    surface.close();
    expect(await answer).toBeUndefined();
  } finally { surface.close(); }
});

test("the ASKING OFF badge is set apart from the idle hint, and a narrow window keeps it without a false WRITES", () => {
  const { surface } = makeSurface();
  try {
    surface.start();
    surface.setStatus("demo-project │ m · high │ ctx 27%~ │ idle", process.cwd());
    surface.setBadge("ASKING OFF · /permissions ask");
    expect(surface.footerLine(200)).toStartWith("ASKING OFF · /permissions ask │ type / for commands │ demo-project");
    expect(surface.footerLine(30)).toContain("ASKING OFF");
    expect(surface.footerLine(30)).not.toContain("WRITES");
    // Both on, too narrow for the whole badge: the short form names both.
    surface.setBadge("ASKING OFF · /permissions ask · WRITES: aruba-central · Ctrl+O");
    expect(surface.footerLine(50)).toStartWith("ASKING OFF · WRITES · Ctrl+O │ ");
    // Allow all with no writes-only server: the short form says ALLOW ALL, not WRITES.
    surface.setBadge("ALLOW ALL: aruba-central · Ctrl+O");
    expect(surface.footerLine(30)).toStartWith("ALLOW ALL · Ctrl+O");
  } finally { surface.close(); }
});

test("ctrl+o turns writes off and denies an open approval; with nothing on, the approval stays open", async () => {
  const { surface, input } = makeSurface();
  try {
    surface.start();
    let on = true;
    let reverts = 0;
    surface.setWritesRevert(() => { reverts++; const was = on; on = false; return was; });
    let settled = false;
    const answer = surface.approve("MCP · lab · set_config  [write]\n", "Make this change?", [{ label: "No" }, { label: "Yes, this once" }]).finally(() => { settled = true; });
    input.write("\x0f");
    expect(await answer).toBeUndefined();
    expect(reverts).toBe(1);
    const second = surface.approve("MCP · lab · set_config  [write]\n", "Make this change?", [{ label: "No" }, { label: "Yes, this once" }]);
    let secondSettled = false;
    void second.finally(() => { secondSettled = true; });
    input.write("\x0f");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(reverts).toBe(2);
    expect(secondSettled).toBe(false);
    expect(settled).toBe(true);
    surface.close();
    expect(await second).toBeUndefined();
  } finally { surface.close(); }
});

test("ctrl+o says Writes are off now when it just turned them off, and writes are already off when nothing was on", async () => {
  const { surface, input } = makeSurface();
  try {
    surface.start();
    surface.setStatus("project/main │ idle", process.cwd());
    let on = true;
    surface.setWritesRevert(() => { const was = on; on = false; return was; });
    input.write("\x0f");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(surface.footerLine(80)).toContain("Writes are off now");
    input.write("\x0f");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(surface.footerLine(80)).toContain("writes are already off");
  } finally { surface.close(); }
});
