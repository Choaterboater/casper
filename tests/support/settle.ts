/**
 * The error a promise rejects with. Bun on Windows can stall a call to a stdio child (an MCP or LSP
 * server) while `expect(promise).rejects` waits on it: the request never reaches the child and the
 * test times out. Awaiting the promise first and checking the error after works on every host.
 */
export async function rejection(promise: Promise<unknown>): Promise<Error> {
  try { await promise; } catch (error) { return error instanceof Error ? error : new Error(String(error)); }
  throw new Error("Expected the promise to reject, but it resolved");
}
