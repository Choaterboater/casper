/** Prints the arguments and the named environment variables it was started with, as JSON. */
const prefixes = (process.env.ENV_DUMP_PREFIXES ?? "HPE_MCP_,CENTRALMCP_,CLEARPASS_,MIST_").split(",");
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => prefixes.some((prefix) => key.startsWith(prefix))));
process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), env }));
