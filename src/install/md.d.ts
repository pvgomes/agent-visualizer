// Markdown files imported with `with { type: "text" }` arrive as strings (esbuild bundles them in).
declare module "*.md" {
  const text: string;
  export default text;
}
