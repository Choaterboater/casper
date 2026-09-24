import { toolError } from "../result";
import type { Tool } from "../tool";
import { validate, type InputSchema } from "../validate";

const inputSchema: InputSchema = {
  type: "object",
  properties: {
    device: { type: "string", description: "Device hostname from the inventory.", minLength: 1 },
    interface: { type: "string", description: "Interface name.", minLength: 1 },
    description: { type: "string", description: "New description." },
  },
  required: ["device", "interface", "description"],
  additionalProperties: false,
};

export const setInterfaceDescription: Tool = {
  name: "set_interface_description",
  description: "Change an interface description on a device (configuration change).",
  inputSchema,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  call(args) {
    const problem = validate(inputSchema, args);
    if (problem) return toolError(problem);
    return toolError("Configuration changes are disabled in this server build.");
  },
};
