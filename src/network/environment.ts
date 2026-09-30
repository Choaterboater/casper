import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isolatedEnvironment } from "../platform/environment";

/**
 * A private folder and a clean environment for one Ansible or Python run.
 *
 * Ansible reads ansible.cfg from the project folder, and that file can name a
 * vault password script, plugin folders or a dynamic inventory that contacts a
 * controller. Casper sets ANSIBLE_CONFIG to its own file instead, so the
 * project's ansible.cfg is never read, and only static inventory plugins are
 * enabled. The environment carries PATH and little else: no provider keys, no
 * ANSIBLE_* variables from your shell (such as ANSIBLE_VAULT_PASSWORD_FILE).
 */
export interface ToolWorkspace {
  dir: string;
  env: Record<string, string>;
  /** Casper's own ansible.cfg (Ansible runs only). */
  config?: string;
  cleanup(): Promise<void>;
}

export interface WorkspaceOptions {
  /** Parent for the private folder (default: the OS temp folder). */
  tmpRoot?: string;
  /** Your real home: Ansible collections installed there stay visible. */
  realHome?: string;
  /** Lab checks keep your real HOME so SSH keys and known_hosts work; offline checks get the private folder. */
  keepHome?: boolean;
  /** The PATH to use (default: Casper's own). */
  path?: string;
}

async function privateFolder(tmpRoot: string | undefined, prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpRoot ?? os.tmpdir(), prefix));
  await chmod(dir, 0o700);
  return dir;
}

function pythonUserBase(realHome: string): Record<string, string> {
  // A pip --user or pipx install of ansible-core lives under the real home.
  const base = process.env.PYTHONUSERBASE ?? (process.platform === "win32" ? undefined : path.join(realHome, ".local"));
  return base ? { PYTHONUSERBASE: base } : {};
}

export function ansibleConfigText(dir: string, realHome: string): string {
  const collections = [path.join(realHome, ".ansible", "collections"), "/usr/share/ansible/collections"].join(":");
  return [
    "# Written by Casper for one run. The project's own ansible.cfg is not read.",
    "[defaults]",
    `collections_path = ${collections}`,
    `local_tmp = ${path.join(dir, "tmp")}`,
    "retry_files_enabled = False",
    "host_key_checking = True",
    "nocows = True",
    "interpreter_python = auto_silent",
    "",
    "[inventory]",
    "enable_plugins = host_list, yaml, ini",
    "",
  ].join("\n");
}

export async function ansibleWorkspace(options: WorkspaceOptions = {}): Promise<ToolWorkspace> {
  const realHome = options.realHome ?? os.homedir();
  const dir = await privateFolder(options.tmpRoot, "casper-ansible-");
  await mkdir(path.join(dir, "tmp"), { mode: 0o700 });
  const config = path.join(dir, "ansible.cfg");
  await writeFile(config, ansibleConfigText(dir, realHome), { mode: 0o600, flag: "wx" });
  const home = options.keepHome ? realHome : dir;
  const extra: Record<string, string> = {
    ANSIBLE_CONFIG: config,
    ANSIBLE_LOCAL_TEMP: path.join(dir, "tmp"),
    ANSIBLE_NOCOLOR: "1",
    ANSIBLE_FORCE_COLOR: "0",
    PYTHONDONTWRITEBYTECODE: "1",
    TMPDIR: dir,
    ...pythonUserBase(realHome),
  };
  if (options.keepHome && process.env.SSH_AUTH_SOCK) extra.SSH_AUTH_SOCK = process.env.SSH_AUTH_SOCK;
  const env = isolatedEnvironment(home, extra);
  if (options.path !== undefined) env.PATH = options.path;
  return { dir, env, config, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/** For the hier_config script: the project's Python, with no network installs (UV_OFFLINE) and no provider keys. */
export async function pythonWorkspace(options: WorkspaceOptions = {}): Promise<ToolWorkspace> {
  const realHome = options.realHome ?? os.homedir();
  const dir = await privateFolder(options.tmpRoot, "casper-python-");
  // uv and poetry keep their caches under the real home; a fresh HOME would make them download again.
  const env = isolatedEnvironment(realHome, { TMPDIR: dir, UV_OFFLINE: "1", PYTHONDONTWRITEBYTECODE: "1", ...pythonUserBase(realHome) });
  if (options.path !== undefined) env.PATH = options.path;
  return { dir, env, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/** For junoser and yanglint: your HOME (Ruby user gems live there), a private TMPDIR, and no provider keys. */
export async function plainWorkspace(options: WorkspaceOptions = {}): Promise<ToolWorkspace> {
  const dir = await privateFolder(options.tmpRoot, "casper-tool-");
  const realHome = options.realHome ?? os.homedir();
  const extra: Record<string, string> = { TMPDIR: dir };
  // rvm and similar set these; rbenv and system Ruby need nothing beyond PATH.
  for (const name of ["GEM_HOME", "GEM_PATH"]) { const value = process.env[name]; if (value) extra[name] = value; }
  const env = isolatedEnvironment(realHome, extra);
  if (options.path !== undefined) env.PATH = options.path;
  return { dir, env, cleanup: () => rm(dir, { recursive: true, force: true }) };
}
