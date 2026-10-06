import type { BrowserSession } from "../browser/session";
import { browserTool } from "../browser/tools";
import type { CapabilityBroker } from "../capabilities/broker";
import type { LSPManager, ConfirmRename } from "../lsp/manager";
import { lspTools } from "../lsp/tools";
import type { ReferenceLibrary } from "../references/library";
import { serviceRequested } from "../services/tool";
import type { RuntimeTool } from "../runtime/types";
import type { VisualizationRouter } from "../visualize/router";
import { visualizationTools } from "../visualize/tools";

/** What one task's tool surface is assembled from. Tool factories close over live app state,
 * so they are constructed by the owner and passed in; assembly only decides membership. */
export interface TaskCapabilitySource {
  broker: CapabilityBroker;
  delegate: RuntimeTool;
  ask: RuntimeTool;
  check?: RuntimeTool;
  lsp: LSPManager;
  confirmRename: ConfirmRename;
  references: ReferenceLibrary;
  /** casper_read_untrusted; unset when reader: off. */
  reader?: RuntimeTool;
  /** web_search and web_fetch; unset when web lookups are off (web: off). */
  web?: RuntimeTool[];
  visualization: VisualizationRouter;
  /** Workspace root for repo-scoped visualization. */
  projectRoot: string;
  /** The project's sandbox.denyRead (absolute): the visualize tool doesn't scan them. */
  privatePaths?: readonly string[];
  /** True when the owned browser session already ran a task and can be reused. */
  browserReady: boolean;
  /** Chrome (or CASPER_BROWSER_EXECUTABLE) is on this machine: the browser tool is there from the first turn. */
  browserInstalled?: boolean;
  /** Lazily creates (or returns) the owned browser session; called only when the browser tool runs. */
  browser: () => BrowserSession;
  browserSignal?: AbortSignal;
  /** Whether the project declares services and whether one is starting or ready. */
  services: { declared: boolean; live: boolean };
  /** Builds the service tool (its manager is created on first use); called only when it is included. */
  serviceTool: () => RuntimeTool;
  /** Tool names already offered in this session. They stay offered, so the tool list, and with it
   * the provider's prompt cache, does not change from one turn to the next. */
  offered?: ReadonlySet<string>;
}

/** Web/browser vocabulary in the task (or a live session) pulls in the browser tool. */
export function browserRequested(task: string, browserReady: boolean): boolean {
  return /https?:\/\/|\b(browser|website|webpage|frontend|layout|responsive|overflow|css|puppeteer|playwright)\b/i.test(task) || browserReady;
}

/** The complete custom tool surface for one task, in the established order: MCP capabilities,
 * delegation, clarification, managed checks, LSP, references, web lookups, the untrusted-text reader, browser, services, visualization.
 * Casper's own tools, once offered, stay offered for the session: a changed tool list throws away
 * the provider's prompt cache. The direct MCP tools are picked once per session (again when a server
 * connects or disconnects); find_capability reaches the rest. */
export async function assembleTaskTools(task: string, source: TaskCapabilitySource): Promise<RuntimeTool[]> {
  const kept = (name: string) => source.offered?.has(name) ?? false;
  const browser = source.browserInstalled || browserRequested(task, source.browserReady) || kept("browser");
  const service = serviceRequested(task, source.services) || kept("service");
  return [
    ...await source.broker.prepare(task),
    source.delegate,
    source.ask,
    ...(source.check ? [source.check] : []),
    ...lspTools(source.lsp, source.confirmRename),
    ...source.references.tools(),
    ...(source.web ?? []),
    ...(source.reader ? [source.reader] : []),
    ...(browser ? [browserTool(source.browser, source.browserSignal)] : []),
    ...(service ? [source.serviceTool()] : []),
    // Diagrams need nothing installed, so this one is always there.
    ...visualizationTools({ router: source.visualization, projectRoot: source.projectRoot, privatePaths: source.privatePaths ?? [] }),
  ];
}
