/* esbuild's "text" loader turns .svg and .css imports into plain strings. */
declare module "*.svg" {
  const source: string;
  export default source;
}
declare module "*.css" {
  const source: string;
  export default source;
}
