import { findMac } from "./find";
import type { DeviceData } from "./inventory";
import { InvalidMacError } from "./mac";

const json = (status: number, body: unknown) => Response.json(body, { status });

/** `GET /mac/<mac>` → 200 location, 404 `not_found`, 400 `invalid_mac`. */
export function createHandler(devices: readonly DeviceData[]) {
  return (request: Request): Response => {
    const match = /^\/mac\/([^/]+)$/.exec(new URL(request.url).pathname);
    if (!match) return json(404, { error: "not_found" });
    if (request.method !== "GET") return json(405, { error: "method_not_allowed" });
    try {
      const location = findMac(devices, decodeURIComponent(match[1]!));
      return location ? json(200, location) : json(404, { error: "not_found" });
    } catch (error) {
      if (error instanceof InvalidMacError) return json(400, { error: "invalid_mac" });
      throw error;
    }
  };
}
