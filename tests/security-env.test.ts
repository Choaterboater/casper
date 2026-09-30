import { expect, test } from "bun:test";
import path from "node:path";
import { DEAD_PROXY } from "../src/mcp/check/sandbox";
import { installEnv, securityEnv, securityHome } from "../src/security/env";

const base = {
  PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8", LC_ALL: "C", TMPDIR: "/tmp/x", HOME: "/home/me", USER: "me",
  MIST_APITOKEN: "abc123", GH_TOKEN: "ghp_x", CENTRAL_CLIENT_ID: "client-id-value", MIST_ORG_ID: "org-1", AWS_PROFILE: "prod",
  ANTHROPIC_API_KEY: "sk-ant", OPENAI_API_KEY: "sk-x", HTTPS_PROXY: "http://corp:8080", https_proxy: "http://corp:8080",
  SSH_AUTH_SOCK: "/tmp/agent.sock", PYTHONPATH: "/evil", SEMGREP_APP_TOKEN: "t",
};

test("security tools get an allowlisted env: no tokens, not even names the secret pattern misses", () => {
  const env = securityEnv(base, { homeDir: "/home/me", platform: "linux" });
  for (const name of ["MIST_APITOKEN", "GH_TOKEN", "CENTRAL_CLIENT_ID", "MIST_ORG_ID", "AWS_PROFILE", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "SSH_AUTH_SOCK", "PYTHONPATH", "SEMGREP_APP_TOKEN", "USER"]) {
    expect(env[name]).toBeUndefined();
  }
  expect(Object.values(env)).not.toContain("client-id-value");
  expect(env).toMatchObject({ PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8", LC_ALL: "C", TMPDIR: "/tmp/x" });
});

test("security tools get a dead proxy, metrics off, offline flags and Casper's own empty HOME", () => {
  const env = securityEnv(base, { homeDir: "/home/me", platform: "linux" });
  for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) expect(env[name]).toBe(DEAD_PROXY);
  expect(env).toMatchObject({
    SEMGREP_SEND_METRICS: "off", SEMGREP_ENABLE_VERSION_CHECK: "0", ZIZMOR_OFFLINE: "1", UV_OFFLINE: "1", PYTHONNOUSERSITE: "1",
    HOME: path.join("/home/me", ".casper", "security", "home"), XDG_CONFIG_HOME: path.join(securityHome("/home/me"), ".config"),
  });
  expect(securityEnv(base, { homeDir: "/home/me", extra: { OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY: "/db" } }).OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY).toBe("/db");
});

test("the install step keeps the user's proxy but no credentials", () => {
  const env = installEnv(base);
  expect(env.HTTPS_PROXY).toBe("http://corp:8080");
  expect(env.PATH).toBe("/usr/bin:/bin");
  for (const name of ["MIST_APITOKEN", "GH_TOKEN", "CENTRAL_CLIENT_ID", "ANTHROPIC_API_KEY", "PYTHONPATH", "SEMGREP_APP_TOKEN", "AWS_PROFILE"]) expect(env[name]).toBeUndefined();
});
