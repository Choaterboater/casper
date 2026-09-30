/** Bun embeds these as text (import ... with { type: "text" }), so they ship inside the binary. */
declare module "*.py" {
  const text: string;
  export default text;
}

declare module "*.yml" {
  const text: string;
  export default text;
}
