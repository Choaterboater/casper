import { toolError, toolText } from "../result";
import type { Tool } from "../tool";
import { validate, type InputSchema } from "../validate";

const inputSchema: InputSchema = {
  type: "object",
  properties: { device: { type: "string", description: "Device hostname from the inventory.", minLength: 1 } },
  required: ["device"],
  additionalProperties: false,
};

export const showVersion: Tool = {
  name: "show_version",
  description: "Show a device's model and firmware version.",
  inputSchema,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  call(args, inventory) {
    const problem = validate(inputSchema, args);
    if (problem) return toolError(problem);
    const { device } = args as { device: string };
    const state = inventory.get(device);
    if (!state) return toolError(`Unknown device: ${device}`);
    return toolText(JSON.stringify({ device, model: state.model, firmware: state.firmware }));
  },
};
