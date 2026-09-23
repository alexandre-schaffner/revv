import type { NoulQuestion } from "@typesafe-ai/sdk";

/** Canonical binary System One question constructor. */
export function noulQuestion(instructions: string): NoulQuestion {
  return { type: "noul", instructions };
}

/** Read a dynamically keyed score answer at the SDK response boundary. */
export function scoreAnswerAt(answers: object, key: string): number | null {
  const answer: unknown = Reflect.get(answers, key);
  if (answer === null || typeof answer !== "object") return null;
  const score: unknown = Reflect.get(answer, "score");
  return typeof score === "number" ? score : null;
}
