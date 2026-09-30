/** Bundled flows are Markdown text imports (`with { type: "text" }`), embedded in release executables. */
declare module "*.md" {
  const text: string;
  export default text;
}
