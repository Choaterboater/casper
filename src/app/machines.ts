import { sshHostNames } from "../sandbox/remote";

/**
 * Machines a conversation reached over ssh. An AI asked "install Home Assistant" after working on a NAS wrote the
 * compose file in the project folder and tried to copy it over; the next request now says which machines the
 * conversation worked on, so work meant for one happens there.
 */

/** The machines a task reached, kept for the next requests (at most three, newest last). */
export function rememberMachines(app: { machines: string[] }, remote: ReadonlyArray<{ host: string }> | undefined): void {
  for (const { host } of remote ?? []) app.machines = [...app.machines.filter((known) => known !== host), host].slice(-3);
}

/** Each machine with the name the person's ssh config gives it: `nas (192.0.2.31)`. */
export function machineNames(machines: readonly string[], home?: string): string[] {
  if (!machines.length) return [];
  const names = sshHostNames(home);
  return machines.map((host) => {
    const named = names.find((entry) => entry.hostName.toLowerCase() === host.toLowerCase() && entry.name !== host);
    return named ? `${named.name} (${host})` : host;
  });
}
