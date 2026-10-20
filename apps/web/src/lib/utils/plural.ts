/** `1 issue`, `3 issues`; `many` for a plural that isn't `word` + "s". */
export function plural(n: number, word: string, many = `${word}s`): string {
  return `${n} ${n === 1 ? word : many}`;
}
