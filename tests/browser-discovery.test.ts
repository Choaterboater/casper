import { expect, test } from "bun:test";
import { browserCandidates, browserUnavailable, isWsl, wslBrowserHint } from "../src/browser/discovery";

test("WSL is told apart from other Linux by its kernel or its environment", () => {
  expect(isWsl("linux", {}, "Linux version 6.6.87.2-microsoft-standard-WSL2 (gcc) #1 SMP")).toBe(true);
  expect(isWsl("linux", { WSL_DISTRO_NAME: "Ubuntu" }, "")).toBe(true);
  expect(isWsl("linux", {}, "Linux version 6.8.0-45-generic (buildd@lcy02)")).toBe(false);
  expect(isWsl("darwin", { WSL_DISTRO_NAME: "Ubuntu" }, "microsoft")).toBe(false);
  expect(isWsl("win32", {}, "")).toBe(false);
});

test("on Linux and WSL, Chrome from Google's package, Edge and a Chrome on PATH are found too", () => {
  const onPath = new Map([["google-chrome-stable", "/home/user/bin/google-chrome-stable"], ["chromium", "/snap/bin/chromium"]]);
  const found = browserCandidates("linux", {}, (name) => onPath.get(name));
  expect(found).toContain("/opt/google/chrome/chrome");
  expect(found).toContain("/usr/bin/microsoft-edge");
  expect(found).toContain("/home/user/bin/google-chrome-stable");
  // The fixed places first, then PATH; no repeats.
  expect(found.indexOf("/usr/bin/google-chrome")).toBeLessThan(found.indexOf("/home/user/bin/google-chrome-stable"));
  expect(new Set(found).size).toBe(found.length);
  // Never a Windows browser under /mnt/c: Casper drives Chrome over pipes, which a Windows program can't use from WSL.
  expect(found.some((candidate) => candidate.startsWith("/mnt/"))).toBe(false);
});

test("with no browser, WSL is told how to get a Linux one, and not to start the Windows one", () => {
  const wsl = browserUnavailable("linux", { WSL_DISTRO_NAME: "Ubuntu" }, "");
  expect(wsl).toBe("Browser unavailable: this is WSL, and Casper drives a Chrome inside WSL, not the Windows one under /mnt/c. "
    + "Install it in WSL: wget https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb && sudo apt install -y ./google-chrome-stable_current_amd64.deb "
    + "(or set CASPER_BROWSER_EXECUTABLE). Don't start the Windows Chrome yourself; tell the user.");
  expect(browserUnavailable("linux", {}, "Linux version 6.8.0-generic")).toBe("Browser unavailable: install Chrome yourself or set CASPER_BROWSER_EXECUTABLE to an absolute executable path");
  expect(browserUnavailable("darwin", {}, "")).toBe("Browser unavailable: install Chrome yourself or set CASPER_BROWSER_EXECUTABLE to an absolute executable path");
});

test("/look's missing-browser line adds the WSL way to get one, only on WSL", () => {
  expect(wslBrowserHint("linux", { WSL_DISTRO_NAME: "Ubuntu" }, "")).toContain("On WSL that means one inside WSL, not the Windows Chrome: wget https://dl.google.com/");
  expect(wslBrowserHint("linux", {}, "Linux version 6.8.0-generic")).toBe("");
  expect(wslBrowserHint("win32", {}, "")).toBe("");
});
