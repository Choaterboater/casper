/**
 * The environment for everything `casper mcp check` runs: the repo's doctor, its tests, the server and the
 * Inspector. Offline mode is best effort, not a guarantee: it removes credentials Casper can see and points
 * web proxies at a dead port, but a program that reads its own .env file or opens SSH itself can still
 * reach the network.
 */

/** Environment names that look like credentials. Offline mode never passes them on. */
export const SECRET_ENV_NAME = /(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE_KEY|CLIENT_SECRET|BEARER|CREDENTIAL)/i;

/** A closed local port: web requests through the proxy fail at once instead of reaching the internet. */
export const DEAD_PROXY = "http://127.0.0.1:9";

const PROXY_NAMES = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"];
/** The names offline mode sets itself. An example config may not change them (only --env may). */
export const OFFLINE_GUARD_NAME = /^((https?|all|no)_proxy|uv_offline|pip_no_index|npm_config_offline)$/i;

export function offlineEnv(base: NodeJS.ProcessEnv, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(base)) {
    // Every case variant of a proxy name goes, so the child cannot pick up an old proxy by another spelling.
    if (value !== undefined && !SECRET_ENV_NAME.test(name) && !/^(https?|all|no)_proxy$/i.test(name)) env[name] = value;
  }
  for (const name of PROXY_NAMES) {
    env[name] = DEAD_PROXY;
    env[name.toLowerCase()] = DEAD_PROXY;
  }
  env.NO_PROXY = env.no_proxy = "localhost,127.0.0.1,::1";
  env.UV_OFFLINE = "1";
  env.PIP_NO_INDEX = "1";
  env.npm_config_offline = "true";
  // The user's own --env values win: they asked for them by name.
  return { ...env, ...extra };
}

/** --live: the real environment, plus the user's --env values. */
export function liveEnv(base: NodeJS.ProcessEnv, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...base, ...extra };
}

export function checkEnv(live: boolean, base: NodeJS.ProcessEnv, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return live ? liveEnv(base, extra) : offlineEnv(base, extra);
}
