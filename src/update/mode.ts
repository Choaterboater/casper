/** A compiled binary runs from Bun's embedded filesystem (`/$bunfs/…`, `B:\~BUN\…`); its real location is the
 * executable. Anything else is a source checkout running src/cli.ts. `--version` and `casper update` both ask. */
export function runningFromBinary(modulePath: string): boolean {
  return /(^|[\\/])(\$bunfs|~BUN)[\\/]/.test(modulePath);
}
