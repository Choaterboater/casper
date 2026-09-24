import { withSession, type SessionOptions } from "./session";

export interface SystemSummary {
  readonly hostname: string;
  readonly firmware: string;
  readonly interfaceCount: number;
}

export function getSystemSummary(options: SessionOptions): Promise<SystemSummary> {
  return withSession(options, async (session) => {
    const system = await session.get<{ hostname: string; firmware_version: string }>("/system?attributes=hostname,firmware_version");
    const interfaces = await session.get<Record<string, unknown>>("/system/interfaces");
    return { hostname: system.hostname, firmware: system.firmware_version, interfaceCount: Object.keys(interfaces).length };
  });
}
