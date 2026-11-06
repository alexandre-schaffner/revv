/**
 * Higher score = better match; -1 means no match. An empty query scores 0 and
 * the caller decides what "no filter" means.
 */
export function fuzzyScore(query: string, text: string): number {
  if (query.length === 0) return 0;

  const lq = query.toLowerCase();
  const lt = text.toLowerCase();

  const idx = lt.indexOf(lq);
  if (idx !== -1) {
    return 100 + (idx === 0 ? 50 : 0);
  }

  let qi = 0;
  let score = 0;
  for (let ti = 0; ti < lt.length && qi < lq.length; ti++) {
    if (lt[ti] === lq[qi]) {
      if (ti === 0 || /[\s\-_/]/.test(lt[ti - 1] as string)) score += 10;
      score += 5;
      qi++;
    }
  }

  return qi === lq.length ? score : -1;
}
