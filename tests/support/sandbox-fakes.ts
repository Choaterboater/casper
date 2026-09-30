import type { SandboxEngine } from "../../src/sandbox/runtime";
import type { SandboxPolicy } from "../../src/sandbox/policy";

export interface FakeEngine extends SandboxEngine {
  /** Every wrap, in order. */
  readonly wrapped: Array<{ command: string; network: string; id: string; policy: SandboxPolicy }>;
  /** The host question the sandbox passed to the engine. */
  ask?: (host: string, port: number | undefined) => Promise<boolean>;
  allowed: string[];
}

/**
 * A fake sandbox engine: the command runs as it is, with CASPER_FAKE_HELD set to its network mode so a test can
 * see it was held. `refuse(command)` names what the "sandbox" refused for that command.
 */
export function fakeEngine(refuse: (command: string) => string[] = () => []): FakeEngine {
  const refusals = new Map<string, string[]>();
  const engine: FakeEngine = {
    wrapped: [],
    allowed: [],
    async initialize(policy, ask) { engine.ask = ask; engine.allowed = [...policy.allowedDomains]; },
    async wrap(command, policy, run) {
      engine.wrapped.push({ command, network: run.network, id: run.id, policy });
      refusals.set(run.id, refuse(command));
      return `CASPER_FAKE_HELD=${run.network}; export CASPER_FAKE_HELD; ${command}`;
    },
    violations(id) { return refusals.get(id) ?? []; },
    setAllowedHosts(hosts) { engine.allowed = [...hosts]; },
    async reset() {},
  };
  return engine;
}
