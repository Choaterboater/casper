/** Whether ssh's own words say the login was refused (a wrong or missing password, key or method), not that the machine
 * was unreachable or a file was not writable. Used only to decide when the AI is reminded how Casper asks for a password.
 * ssh words it "Permission denied (publickey,password).", so a bare "Permission denied" from a remote file does not count. */
const REFUSED = /Permission denied \([a-z0-9,-]+\)|Permission denied, please try again|Authentication failed|No (?:more )?authentication methods|Too many authentication failures/i;

export function looksLikeRefusedLogin(output: string): boolean {
  return REFUSED.test(output);
}
