// A review round's focus title: five words from the commit subject that best
// names the round's commits, read from the commit list the walkthrough row
// recorded at job start.

import { decodePrCommits, type StoredPrCommit } from "./content";

export function commitsInRoundRange(
  commits: readonly StoredPrCommit[],
  fromSha: string | null,
  toSha: string,
): readonly StoredPrCommit[] {
  const toIndex = commits.findIndex((commit) => commit.sha === toSha);
  const fromIndex = fromSha ? commits.findIndex((commit) => commit.sha === fromSha) : -1;
  if (fromSha !== null && fromSha === toSha) return [];

  if (toIndex !== -1 && fromIndex !== -1) {
    if (fromIndex < toIndex) {
      return commits.slice(fromIndex + 1, toIndex + 1);
    }
    return commits.slice(toIndex, fromIndex).reverse();
  }

  if (toIndex !== -1) {
    const prefix = commits.slice(0, toIndex + 1);
    return prefix.length > 1 && commits[0]?.sha === toSha ? prefix.reverse() : prefix;
  }

  if (fromIndex !== -1) {
    return commits.slice(fromIndex + 1);
  }

  return commits;
}

function subjectFromCommitMessage(message: string): string {
  return message.split("\n", 1)[0]?.trim() ?? "";
}

function cleanCommitSubject(subject: string): string {
  return subject
    .replace(/^revert\s+"?(.+?)"?$/i, "$1")
    .replace(/^\w+(?:\([^)]+\))?!?:\s+/i, "")
    .replace(/\b(?:[A-Z][A-Z0-9]+-\d+|#\d+)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isLowSignalSubject(subject: string): boolean {
  return /^(?:merge|revert|chore|style|format|lint|test|tests|wip|fixup)\b/i.test(subject);
}

function toFiveWordTitle(text: string): string | null {
  const words = text
    .replace(/[`*_#()[\]{}]/g, "")
    .split(/\s+/)
    .map((word) => word.replace(/^[^\w]+|[^\w]+$/g, ""))
    .filter((word) => word.length > 0);
  if (words.length === 0) return null;
  return words.slice(0, 5).join(" ");
}

export function deriveRoundFocusTitle(
  rawCommits: string | null,
  fromSha: string | null,
  toSha: string,
): string | null {
  const commits = commitsInRoundRange(decodePrCommits(rawCommits), fromSha, toSha);
  const subjects = commits
    .map((commit) => subjectFromCommitMessage(commit.message))
    .filter((subject) => subject.length > 0);
  if (subjects.length === 0) return null;

  const preferred = [...subjects].reverse().find((subject) => !isLowSignalSubject(subject));
  return toFiveWordTitle(cleanCommitSubject(preferred ?? subjects.at(-1) ?? ""));
}
