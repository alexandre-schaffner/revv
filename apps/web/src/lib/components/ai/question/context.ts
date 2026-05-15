export type QuestionStatus =
	| "pending"
	| "answered"
	| "rejected"
	| "superseded";

export interface QuestionContext {
	readonly status: QuestionStatus;
	readonly submitting: boolean;
	readonly previewFormat: "markdown" | "html";
}

export const QUESTION_CTX_KEY = Symbol("ai-question");
