/** Bun's file loader embeds the C bridge in standalone release executables. */
declare module "*.c" {
  const filename: string;
  export default filename;
}
