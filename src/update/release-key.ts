/**
 * The public half of the Casper release key, as an OpenSSH line (`ssh-ed25519 AAAA…`). The release workflow signs
 * SHA256SUMS with the private half (the RELEASE_SIGNING_KEY secret) and `casper update` and both installers check it.
 * Empty until the owner creates the key: then nothing is checked. Set it with `bun scripts/release-key.ts <file.pub>`,
 * which writes the same line here and in both installers (docs/RELEASE.md, "The release key").
 */
export const RELEASE_KEY = "";
