/**
 * Read one numeric field of a dynamically keyed answer at the SDK response
 * boundary — `score` for a score question, `noul` for a noul one — for a
 * question map chosen at runtime. Null when the answer or field is missing.
 */
export function numericAnswerAt(
  answers: object,
  key: string,
  field: "score" | "noul",
): number | null {
  const answer: unknown = Reflect.get(answers, key);
  if (answer === null || typeof answer !== "object") return null;
  const value: unknown = Reflect.get(answer, field);
  return typeof value === "number" ? value : null;
}
