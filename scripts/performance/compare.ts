import { readFile } from "node:fs/promises";
import { compare, measurement } from "./model";

const [before, after] = Bun.argv.slice(2);
if (!before || !after) throw new Error("Usage: perf:compare <baseline.json> <candidate.json>");
const result = compare(
  measurement(JSON.parse(await readFile(before, "utf8"))),
  measurement(JSON.parse(await readFile(after, "utf8"))),
);
console.log(JSON.stringify(result, null, 2));
process.exitCode = result.verdict === "improved" ? 0 : result.verdict === "regressed" ? 1 : 2;
