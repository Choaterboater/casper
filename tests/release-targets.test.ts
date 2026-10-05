import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { artifactName, hostTarget, TARGETS } from "../scripts/build-release";

const repoRoot = path.resolve(import.meta.dir, "..");
const read = (file: string) => readFile(path.join(repoRoot, file), "utf8");

const RELEASE_FILES = [
  "casper-darwin-arm64",
  "casper-darwin-x64",
  "casper-linux-x64",
  "casper-linux-arm64",
  "casper-windows-x64.exe",
  "casper-windows-arm64.exe",
];

test("a release has one file per platform, Windows ARM64 included", () => {
  expect(TARGETS.map(artifactName)).toEqual(RELEASE_FILES);
});

test("the publish workflow checks every release file by name, and the release docs list them", async () => {
  const workflow = await read(".github/workflows/publish-release.yml");
  const releaseDoc = await read("docs/RELEASE.md");
  for (const file of RELEASE_FILES) {
    expect({ file, inWorkflow: workflow.includes(` ${file}`) }).toEqual({ file, inWorkflow: true });
    expect({ file, inDocs: releaseDoc.includes(`| \`${file}\` |`) }).toEqual({ file, inDocs: true });
  }
});

/**
 * install.ps1 picks its file in one function, so these cases feed it fake values instead of
 * this PC's. Any PowerShell runs it: Windows has 5.1 (and often 7); the Linux and macOS CI
 * runners have pwsh 7. A host with none skips, because there is nothing to run it with.
 */
const shells = [...new Set(["powershell", "pwsh"].map((name) => Bun.which(name)).filter((found): found is string => !!found))];

async function pickArtifact(shell: string, processArch: string, wow64: string, machine: string) {
  const installer = await read("scripts/install.ps1");
  const start = installer.indexOf("function Select-CasperArtifact");
  const end = installer.indexOf("\n}\n", start);
  expect({ start: start >= 0, end: end > start }).toEqual({ start: true, end: true });
  const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
  const script = `$ErrorActionPreference = 'Stop'\n${installer.slice(start, end + 3)}\n` +
    `try { Select-CasperArtifact ${quote(processArch)} ${quote(wow64)} ${quote(machine)} } catch { Write-Output "error: $($_.Exception.Message)" }`;
  return runPowerShell(shell, script);
}

/** -EncodedCommand runs the whole script as one block in 5.1 and 7 alike (stdin input runs line by line). */
async function runPowerShell(shell: string, script: string) {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const child = Bun.spawn([shell, "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  // stderr can hold PowerShell's own progress records ("Preparing modules for first use"), so
  // it is only shown when the answer is wrong.
  return { out: stdout.trim(), exitCode, ...(exitCode === 0 && stdout.trim() ? {} : { stderr: stderr.trim() }) };
}

test.skipIf(shells.length === 0)("install.ps1 picks the ARM64 file on ARM64, even from an x64 or 32-bit PowerShell", async () => {
  const cases: Array<[processArch: string, wow64: string, machine: string, expected: string]> = [
    ["AMD64", "", "AMD64", "casper-windows-x64.exe"],
    ["ARM64", "", "ARM64", "casper-windows-arm64.exe"],
    // x64 PowerShell under emulation on an ARM64 PC: the process says AMD64, W6432 is unset.
    ["AMD64", "", "ARM64", "casper-windows-arm64.exe"],
    // 32-bit PowerShell: x86 in the process, the real machine in W6432.
    ["x86", "ARM64", "ARM64", "casper-windows-arm64.exe"],
    ["x86", "AMD64", "AMD64", "casper-windows-x64.exe"],
    // The registry value couldn't be read: the process values decide.
    ["x86", "ARM64", "", "casper-windows-arm64.exe"],
    ["ARM64", "", "", "casper-windows-arm64.exe"],
    ["AMD64", "", "", "casper-windows-x64.exe"],
    // 32-bit Windows has no release file.
    ["x86", "", "x86", "error: Unsupported architecture: x86. Casper has Windows files for x64 and ARM64 only."],
  ];
  for (const shell of shells) {
    for (const [processArch, wow64, machine, expected] of cases) {
      const result = await pickArtifact(shell, processArch, wow64, machine);
      expect({ shell, processArch, wow64, machine, ...result }).toEqual({ shell, processArch, wow64, machine, out: expected, exitCode: 0 });
    }
  }
}, 60_000);

test.skipIf(process.platform !== "win32")("install.ps1 picks this PC's own file here", async () => {
  const installer = await read("scripts/install.ps1");
  const call = installer.match(/^\$Artifact = Select-CasperArtifact .+$/m)?.[0];
  expect(call).toBeDefined();
  const start = installer.indexOf("function Select-CasperArtifact");
  const machineLine = installer.match(/^\$MachineArch = .+$/m)?.[0];
  expect(machineLine).toBeDefined();
  const script = `$ErrorActionPreference = 'Stop'\n${installer.slice(start, installer.indexOf("\n}\n", start) + 3)}\n${machineLine}\n${call}\n$Artifact`;
  expect(await runPowerShell("powershell", script)).toEqual({ out: artifactName(hostTarget()), exitCode: 0 });
}, 30_000);
