import { MAX_OUTPUT_CHARS, toolError, toolText } from "../result";
import type { Tool } from "../tool";
import { validate, type InputSchema } from "../validate";

const LIMIT = 50;

const inputSchema: InputSchema = {
  type: "object",
  properties: {
    device: { type: "string", description: "Device hostname from the inventory.", minLength: 1 },
    prefix: { type: "string", description: "Only interfaces whose name starts with this text, e.g. \"1/1/\" or \"ge-0/0/\"." },
    operUp: { type: "boolean", description: "Only interfaces that are operationally up (true) or down (false)." },
  },
  required: ["device"],
  additionalProperties: false,
};

export const showInterfaces: Tool = {
  name: "show_interfaces",
  description: "Show interface status (admin/oper state, description, speed) for a device; filter by name prefix or oper state.",
  inputSchema,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  call(args, inventory) {
    const problem = validate(inputSchema, args);
    if (problem) return toolError(problem);
    const { device, prefix, operUp } = args as { device: string; prefix?: string; operUp?: boolean };
    const state = inventory.get(device);
    if (!state) return toolError(`Unknown device: ${device}. Known devices: ${[...inventory.keys()].sort().join(", ")}`);
    const matches = state.interfaces.filter((entry) => (prefix === undefined || entry.name.startsWith(prefix)) && (operUp === undefined || entry.operUp === operUp));
    const interfaces = matches.slice(0, LIMIT).map(({ name, adminUp, operUp: up, description, speedMbps }) => ({ name, adminUp, operUp: up, description, speedMbps }));
    let body = { device, total: matches.length, truncated: matches.length > interfaces.length, interfaces };
    while (JSON.stringify(body).length > MAX_OUTPUT_CHARS && body.interfaces.length) {
      body = { ...body, truncated: true, interfaces: body.interfaces.slice(0, -1) };
    }
    return toolText(JSON.stringify(body));
  },
};
