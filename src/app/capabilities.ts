import type { BrowserSession } from "../browser/session";
import { browserTool } from "../browser/tools";
import type { CapabilityBroker } from "../capabilities/broker";
import type { LSPManager, ConfirmRename } from "../lsp/manager";
import { lspTools } from "../lsp/tools";
import type { ReferenceLibrary } from "../references/library";
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
  visualization: VisualizationRouter;
  /** Workspace root for repo-scoped visualization. */
  projectRoot: string;
  /** True when the owned browser session already ran a task and can be reused. */
  browserReady: boolean;
  /** Lazily creates (or returns) the owned browser session; called only when browser tools are included. */
  browser: () => BrowserSession;
  browserSignal?: AbortSignal;
}

/** Web/browser vocabulary in the task (or a live session) pulls in the browser tool. */
export function browserRequested(task: string, browserReady: boolean): boolean {
  return /https?:\/\/|\b(browser|website|webpage|frontend|layout|responsive|overflow|css|puppeteer|playwright)\b/i.test(task) || browserReady;
}

/** The complete custom tool surface for one task, in the established order: MCP capabilities,
 * delegation, clarification, managed checks, LSP, references, browser, visualization. */
export async function assembleTaskTools(task: string, includeVisualization: boolean, source: TaskCapabilitySource): Promise<RuntimeTool[]> {
  return [
    ...await source.broker.prepare(task),
    source.delegate,
    source.ask,
    ...(source.check ? [source.check] : []),
    ...lspTools(source.lsp, source.confirmRename),
    ...source.references.tools(),
    ...(browserRequested(task, source.browserReady) ? [browserTool(source.browser(), source.browserSignal)] : []),
    ...(includeVisualization ? visualizationTools({ router: source.visualization, projectRoot: source.projectRoot }) : []),
  ];
}
