export interface InterfaceState {
  readonly name: string;
  readonly adminUp: boolean;
  readonly operUp: boolean;
  readonly description: string | null;
  readonly speedMbps: number | null;
}

export interface DeviceState {
  readonly hostname: string;
  readonly model: string;
  readonly firmware: string;
  readonly interfaces: readonly InterfaceState[];
}

/** Hostname → last collected state. */
export type Inventory = ReadonlyMap<string, DeviceState>;
