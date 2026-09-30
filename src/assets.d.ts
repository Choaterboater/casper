/** Bun's file loader embeds the C bridge in standalone release executables. */
declare module "*.txt" {
  const text: string;
  export default text;
}

declare module "*.c" {
  const filename: string;
  export default filename;
}

/** The sandbox runtime's seccomp helper, embedded as a file (src/sandbox/seccomp.ts). */
declare module "*/apply-seccomp" {
  const filename: string;
  export default filename;
}
