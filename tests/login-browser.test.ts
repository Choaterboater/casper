import { expect, test } from "bun:test";
import { browserCommand } from "../src/tui/login";

// A sign-in address has several query parts joined by "&".
const url = "https://auth.example.com/oauth/authorize?response_type=code&client_id=app&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fcallback&state=x";

test("Windows: the sign-in address reaches the browser whole, never through cmd (which cuts it at the first &)", () => {
  const argv = browserCommand(url, "win32");
  expect(argv.map((word) => word.toLowerCase())).not.toContain("cmd");
  expect(argv.at(-1)).toBe(url);
});

test("macOS and Linux open it with their own opener", () => {
  expect(browserCommand(url, "darwin")).toEqual(["open", url]);
  expect(browserCommand(url, "linux")).toEqual(["xdg-open", url]);
});
