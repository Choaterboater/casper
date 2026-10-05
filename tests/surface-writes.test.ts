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
    surface.setBadge("WRITES: aruba-central · ctrl+o");
    expect(surface.footerLine(80)).toStartWith("WRITES: aruba-central · ctrl+o ○ project/main");
    expect(surface.footerLine(30)).toContain("WRITES");
    expect(surface.footerLine(30)).toContain("ctrl+o");
    const answer = surface.approve("Run it?\n", "Make this change?", [{ label: "No" }, { label: "Yes, this once" }]);
    expect(surface.footerLine(80)).toStartWith("WRITES: aruba-central · ctrl+o ? waiting for you");
    surface.setBadge(undefined);
    expect(surface.footerLine(80)).not.toContain("WRITES");
    surface.close();
    expect(await answer).toBeUndefined();
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
