import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import ts from "typescript";

// Mechanical v3 -> v4 edits. AST ranges preserve surrounding formatting and
// avoid rewriting comments/strings. Safe to rerun after manual follow-up edits.
const renames: Record<string, string> = {
  "Effect.catchAll": "Effect.catch",
  "Effect.catchAllCause": "Effect.catchCause",
  "Effect.catchAllDefect": "Effect.catchDefect",
  "Effect.forkDaemon": "Effect.forkDetach",
  "Effect.fork": "Effect.forkChild",
  "Effect.zipRight": "Effect.andThen",
  "Effect.zipLeft": "Effect.tap",
  "Effect.either": "Effect.result",
  "Effect.tapErrorCause": "Effect.tapCause",
  "Effect.ignoreLogged": "Effect.ignore",
  "Effect.makeSemaphore": "Semaphore.make",
  "Effect.Semaphore": "Semaphore.Semaphore",
  "Effect.runtime": "Effect.context",
  "Runtime.runPromise": "Effect.runPromiseWith",
  "Fiber.RuntimeFiber": "Fiber.Fiber",
  "Layer.scoped": "Layer.effect",
  "Layer.scopedDiscard": "Layer.effectDiscard",
  "Cause.failureOption": "Cause.findErrorOption",
  "Cause.isInterruptedOnly": "Cause.hasInterruptsOnly",
  "Config.integer": "Config.Int",
  "Config.int": "Config.Int",
  "Config.string": "Config.String",
  "Config.boolean": "Config.Boolean",
  "Config.Config.Success": "Config.Success",
  "Effect.Effect.Success": "Effect.Success",
  "Context.Tag.Service": "Context.Service.Shape",
  "Effect.orElse": "Effect.catch",
  "Either.isRight": "Result.isSuccess",
  "Either.isLeft": "Result.isFailure",
};

async function files(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map((entry) =>
        entry.isDirectory()
          ? files(join(dir, entry.name))
          : Promise.resolve(entry.name.endsWith(".ts") ? [join(dir, entry.name)] : []),
      ),
    )
  ).flat();
}

let changed = 0;
for (const file of await files("apps/server/src")) {
  const original = await readFile(file, "utf8");
  if (!original.includes('from "effect"')) continue;
  const ast = ts.createSourceFile(file, original, ts.ScriptTarget.Latest, true);
  const edits: { start: number; end: number; text: string }[] = [];
  let needsSemaphore = false;
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      node.arguments.length === 0 &&
      node.expression.getText(ast) === "Effect.yieldNow"
    ) {
      edits.push({ start: node.getStart(ast), end: node.end, text: "Effect.yieldNow" });
      return;
    }
    if (
      ts.isCallExpression(node) &&
      ts.isCallExpression(node.expression) &&
      node.expression.expression.getText(ast) === "Context.Tag" &&
      node.typeArguments
    ) {
      edits.push({
        start: node.getStart(ast),
        end: node.end,
        text: `Context.Service<${node.typeArguments.map((arg) => arg.getText(ast)).join(", ")}>()(${node.expression.arguments.map((arg) => arg.getText(ast)).join(", ")})`,
      });
      return;
    }
    if (ts.isPropertyAccessExpression(node) || ts.isQualifiedName(node)) {
      const replacement = renames[node.getText(ast)];
      if (replacement) {
        edits.push({ start: node.getStart(ast), end: node.end, text: replacement });
        if (replacement.startsWith("Semaphore.")) needsSemaphore = true;
        return;
      }
    }
    if (ts.isIdentifier(node)) {
      let replacement: string | undefined;
      if (node.text === "Either") replacement = "Result";
      if (ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) {
        if (node.text === "left") replacement = "failure";
        if (node.text === "right") replacement = "success";
      }
      if (replacement) edits.push({ start: node.getStart(ast), end: node.end, text: replacement });
    }
    if (ts.isStringLiteral(node) && (node.text === "Left" || node.text === "Right")) {
      edits.push({
        start: node.getStart(ast),
        end: node.end,
        text: JSON.stringify(node.text === "Left" ? "Failure" : "Success"),
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  let source = original;
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    source = source.slice(0, edit.start) + edit.text + source.slice(edit.end);
  }
  if (needsSemaphore)
    source = source.replace(
      /import \{([^}]+)\} from "effect";/,
      (_, imports: string) => `import {${imports}, Semaphore} from "effect";`,
    );
  source = source.replace('"@effect/opentelemetry/Tracer"', '"@effect/opentelemetry/OtelTracer"');
  if (source !== original) {
    await writeFile(file, source);
    changed++;
  }
}
console.log(`Migrated ${changed} files`);
