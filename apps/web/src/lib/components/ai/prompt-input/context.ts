export type PromptInputStatus = "ready" | "submitted" | "streaming" | "error";

export interface PromptInputMessage {
  text: string;
  files?: File[];
}

export interface PromptInputContext {
  readonly status: PromptInputStatus;
  readonly value: string;
  readonly files: readonly File[];
  setValue: (v: string) => void;
  addFiles: (files: readonly File[]) => void;
  removeFile: (index: number) => void;
  readonly submit: () => void;
  readonly stop: () => void;
}

export const PROMPT_INPUT_CTX_KEY = Symbol("ai-prompt-input");
