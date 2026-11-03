// Prompt files are imported `with { type: "text" }` so they are bundled into
// the compiled server instead of being read from the source tree at runtime.
declare module "*.md" {
  const content: string;
  export default content;
}
