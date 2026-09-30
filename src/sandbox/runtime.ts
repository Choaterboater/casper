import { bwrapCommand } from "./linux";
import type { SandboxPolicy } from "./policy";
import { seccompHelper } from "./seccomp";

/**
 * The seam over @anthropic-ai/sandbox-runtime (Apache-2.0): bubblewrap and seccomp on Linux, sandbox-exec
 * on macOS, and the proxy that lets a command reach only listed hosts and asks about the rest. Casper owns
 * the policy; this adapter only passes it on. Tests pass a fake engine instead.
 */
export interface SandboxEngine {
  /** Starts the proxies. `ask` decides a host that is not listed. */
  initialize(policy: SandboxPolicy, ask: (host: string, port: number | undefined) => Promise<boolean>, options: { allowUnixSockets?: string[]; seccompPath?: string }): Promise<void>;
  /** One shell line that runs `command` held by `policy`. `id` ties what it was refused to this run. `prefix` runs
   * first inside the sandbox (TMPDIR). */
  wrap(command: string, policy: SandboxPolicy, run: { id: string; cwd: string; network: "ask" | "host" | "none"; prefix: string }): Promise<string>;
  /** What the sandbox refused for run `id`, as the runtime reports it ("deny openat /etc/hosts"). */
  violations(id: string): string[];
  /** The hosts a command may reach without asking, after "Always for this project". */
  setAllowedHosts(hosts: string[]): void;
  reset(): Promise<void>;
}

type Runtime = typeof import("@anthropic-ai/sandbox-runtime");

/** On Linux, `host` and `none` use Casper's own bubblewrap line (src/sandbox/linux.ts): the runtime's network
 * namespace is shared by every command, so it can't let a dev server be reached from the host or cut one tool
 * off entirely. On macOS every command goes through the runtime. */
export function runtimeEngine(load: () => Promise<Runtime> = () => import("@anthropic-ai/sandbox-runtime"), platform: NodeJS.Platform = process.platform): SandboxEngine {
  let runtime: Runtime | undefined;
  let base: Parameters<Runtime["SandboxManager"]["initialize"]>[0] | undefined;
  let seccomp: string | undefined;
  return {
    async initialize(policy, ask, options) {
      runtime = await load();
      // Casper's own bubblewrap line blocks Unix sockets with the same helper the runtime uses.
      seccomp = platform === "linux" ? options.seccompPath ?? await seccompHelper().catch(() => undefined) : undefined;
      if (platform === "linux" && !seccomp) throw new Error(`no seccomp helper for ${process.arch}, so Unix sockets can't be blocked`);
      base = {
        network: { allowedDomains: [...policy.allowedDomains], deniedDomains: [], allowLocalBinding: true,
          ...(options.allowUnixSockets?.length ? { allowUnixSockets: [...options.allowUnixSockets] } : {}) },
        filesystem: { denyRead: [...policy.denyRead], allowWrite: [...policy.allowWrite], denyWrite: [...policy.denyWrite] },
        ...(seccomp ? { seccomp: { applyPath: seccomp } } : {}),
      } as typeof base;
      await runtime.SandboxManager.initialize(base!, async ({ host, port }) => ask(host, port), true);
    },
    async wrap(command, policy, run) {
      if (platform === "linux" && run.network !== "ask") return bwrapCommand({ policy, network: run.network, cwd: run.cwd, prefix: run.prefix, seccomp }, command);
      if (!runtime) throw new Error("The sandbox is not started");
      return runtime.SandboxManager.wrapWithSandbox(`${run.prefix}\n${command}`, undefined,
        { filesystem: { denyRead: [...policy.denyRead], allowWrite: [...policy.allowWrite], denyWrite: [...policy.denyWrite] } },
        undefined, { commandId: run.id });
    },
    violations(id) {
      if (!runtime) return [];
      return runtime.SandboxManager.getSandboxViolationStore().getViolationsForCommand(id).map((violation) => violation.line);
    },
    setAllowedHosts(hosts) {
      if (!runtime || !base) return;
      base = { ...base, network: { ...base.network, allowedDomains: [...hosts] } };
      runtime.SandboxManager.updateConfig(base);
    },
    async reset() { await runtime?.SandboxManager.reset(); },
  };
}

/** An engine that holds nothing: the command runs as it is. The test suite's default (tests/support/preload.ts);
 * never used by Casper itself. */
export const passThroughEngine = (): SandboxEngine => ({
  async initialize() {},
  async wrap(command) { return command; },
  violations() { return []; },
  setAllowedHosts() {},
  async reset() {},
});
