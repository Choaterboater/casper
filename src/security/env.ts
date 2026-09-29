import path from "node:path";
import { DEAD_PROXY, SECRET_ENV_NAME } from "../mcp/check/sandbox";

/**
 * The environment every security tool runs with. It is an allowlist, not a denylist: a name Casper has
 * not listed never reaches the tool, so CENTRAL_CLIENT_ID or MIST_ORG_ID cannot slip through the way
 * they would past a name pattern. Web proxies point at a dead local port and HOME is Casper's own empty
 * folder, so a tool cannot read the user's ~/.config or cached logins.
 *
 * Best effort, not a guarantee: a dead proxy does not stop a program that opens raw sockets, and some
 * Go programs ignore proxy settings. That stays true until the shell sandbox ships.
 */

/** The names a tool may inherit from Casper's own environment. Everything else is dropped. */
const KEEP_NAMES = new Set(["PATH", "LANG", "LANGUAGE", "TZ", "TMPDIR", "TEMP", "TMP", "TERM"]);
/** Windows needs these for the loader, the console and the user profile paths. */
const KEEP_WINDOWS = new Set(["SYSTEMROOT", "WINDIR", "SYSTEMDRIVE", "COMSPEC", "PATHEXT", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "OS"]);
const PROXY_NAMES = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "GRPC_PROXY"];

/** Casper's own folder that stands in for HOME and XDG_CONFIG_HOME while a tool runs. */
export function securityHome(homeDir: string): string {
  return path.join(homeDir, ".casper", "security", "home");
}

export interface SecurityEnvOptions {
  homeDir: string;
  /** Extra names Casper itself sets for one tool (e.g. the osv-scanner database folder). */
  extra?: Record<string, string>;
  platform?: NodeJS.Platform;
}

export function securityEnv(base: NodeJS.ProcessEnv, options: SecurityEnvOptions): Record<string, string> {
  const windows = (options.platform ?? process.platform) === "win32";
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(base)) {
    if (value === undefined) continue;
    const upper = name.toUpperCase();
    const keep = KEEP_NAMES.has(upper) || upper.startsWith("LC_") || (windows && KEEP_WINDOWS.has(upper));
    // A kept name that still looks like a credential (never expected, but cheap to refuse) is dropped.
    if (keep && !SECRET_ENV_NAME.test(name)) env[name] = value;
  }
  const home = securityHome(options.homeDir);
  env.HOME = home;
  env.XDG_CONFIG_HOME = path.join(home, ".config");
  env.XDG_CACHE_HOME = path.join(home, ".cache");
  env.XDG_DATA_HOME = path.join(home, ".local", "share");
  if (windows) {
    env.USERPROFILE = home;
    env.APPDATA = path.join(home, "AppData", "Roaming");
    env.LOCALAPPDATA = path.join(home, "AppData", "Local");
  }
  for (const name of PROXY_NAMES) {
    env[name] = DEAD_PROXY;
    env[name.toLowerCase()] = DEAD_PROXY;
  }
  env.NO_PROXY = env.no_proxy = "localhost,127.0.0.1,::1";
  env.SEMGREP_SEND_METRICS = "off";
  env.SEMGREP_ENABLE_VERSION_CHECK = "0";
  env.ZIZMOR_OFFLINE = "1";
  env.UV_OFFLINE = "1";
  env.PIP_NO_INDEX = "1";
  env.PYTHONNOUSERSITE = "1";
  env.PYTHONDONTWRITEBYTECODE = "1";
  env.NO_COLOR = "1";
  // ansible-lint: keep collections and galaxy caches in Casper's folder, never the user's.
  env.ANSIBLE_HOME = path.join(home, ".ansible");
  env.ANSIBLE_LOCAL_TEMP = path.join(home, ".ansible", "tmp");
  return { ...env, ...options.extra };
}

/** Names the install and advisory-download steps keep: what uv and osv-scanner need to reach the
 * network through the user's own proxy and certificates. */
const INSTALL_KEEP = /^(PATH|HOME|USER|LOGNAME|LANG|LANGUAGE|TZ|TMPDIR|TEMP|TMP|TERM|LC_\w+|XDG_\w+|(HTTPS?|ALL|NO)_PROXY|SSL_CERT_(FILE|DIR)|REQUESTS_CA_BUNDLE|CURL_CA_BUNDLE|UV_\w+|SYSTEMROOT|WINDIR|SYSTEMDRIVE|COMSPEC|PATHEXT|USERPROFILE|APPDATA|LOCALAPPDATA|PROGRAMDATA|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE|OS)$/i;

/**
 * The environment for the steps that reach the network after the user said yes: installing the pinned
 * tools and downloading osv-scanner's advisory data. It keeps the user's own proxy and certificates
 * (corporate networks need them) and nothing else, and never a name that looks like a credential.
 */
export function installEnv(base: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(base)) {
    if (value === undefined || !INSTALL_KEEP.test(name) || SECRET_ENV_NAME.test(name) || /^UV_OFFLINE$/i.test(name)) continue;
    env[name] = value;
  }
  env.PYTHONNOUSERSITE = "1";
  return env;
}
