import type { QuestionStatus } from "@revv/shared";

export type { QuestionStatus };

export interface QuestionContext {
  readonly status: QuestionStatus;
  readonly submitting: boolean;
  readonly previewFormat: "markdown" | "html";
}

export const QUESTION_CTX_KEY = Symbol("ai-question");
