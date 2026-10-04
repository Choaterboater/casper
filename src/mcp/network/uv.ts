import { spawn } from "node:child_process";
import { installEnv } from "../../security/env";

/**
 * uv's official installer (docs.astral.sh/uv), run only after the person picks "2 Install uv, then set it up" in
 * the network setup question, which shows this exact command first. It installs uv for this user (into
 * ~/.local/bin) and adds that folder to the shell's PATH, as uv's own instructions do.
 */
export interface UvInstaller { shown: string; file: string; args: string[] }

export function uvInstaller(platform: NodeJS.Platform = process.platform): UvInstaller {
  if (platform === "win32") {
    const script = "irm https://astral.sh/uv/install.ps1 | iex";
    return { shown: `powershell -ExecutionPolicy ByPass -c "${script}"`, file: "powershell", args: ["-ExecutionPolicy", "ByPass", "-c", script] };
  }
  const script = "curl -LsSf https://astral.sh/uv/install.sh | sh";
  return { shown: script, file: "sh", args: ["-c", script] };
}

const INSTALL_TIMEOUT_MS = 5 * 60_000;

/** Runs the installer with the person's proxy and certificates (no credentials), for at most 5 minutes. */
export function runUvInstaller(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): Promise<{ ok: boolean; message?: string }> {
  const installer = uvInstaller(platform);
  return new Promise((resolve) => {
    let stderr = "";
    const child = spawn(installer.file, installer.args, { shell: false, stdio: ["ignore", "ignore", "pipe"], windowsHide: true, env: installEnv(env) });
    const timer = setTimeout(() => child.kill("SIGKILL"), INSTALL_TIMEOUT_MS);
    child.stderr?.on("data", (chunk: Buffer) => { stderr = `${stderr}${chunk.toString("utf8")}`.slice(-2048); });
    const done = (result: { ok: boolean; message?: string }) => { clearTimeout(timer); resolve(result); };
    child.once("error", (error) => done({ ok: false, message: error.message }));
    child.once("close", (code) => {
      const last = stderr.trim().split(/\r?\n/).filter(Boolean).at(-1);
      done(code === 0 ? { ok: true } : { ok: false, message: last ?? `exit ${code ?? "unknown"}` });
    });
  });
}
