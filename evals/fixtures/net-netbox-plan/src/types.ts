export interface SourceDevice {
  readonly name: string;
  readonly serial: string | null;
  readonly site: string | null;
  readonly role: string | null;
  readonly primaryIp4: string | null;
}

export type Field = "serial" | "site" | "role" | "primaryIp4";

export interface Change {
  readonly from: string | null;
  readonly to: string | null;
}

export interface Update {
  readonly name: string;
  readonly id: number;
  readonly changes: Partial<Record<Field, Change>>;
}

export interface Plan {
  readonly create: readonly SourceDevice[];
  readonly update: readonly Update[];
  readonly unchanged: readonly string[];
  readonly onlyInNetbox: readonly string[];
}
