/** The MCP stand-ins a fake program can run in its own process (fake-program.ts fakeServerProgram). */
export type FakeServerName = "fake-network-mcp" | "mcp-network-server";

export async function startFakeServer(name: FakeServerName): Promise<void> {
  if (name === "fake-network-mcp") {
    await import("../fixtures/fake-network-mcp");
    return;
  }
  const { networkFixtureServer } = await import("../fixtures/mcp-network-server");
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  await networkFixtureServer(process.env.FIXTURE_MODE).connect(new StdioServerTransport());
}
