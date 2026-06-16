export function tokenizeSkillText(text: string): Set<string> {
  const matches = text.toLowerCase().match(/[a-z0-9]+|[\u4e00-\u9fff]/gu) ?? [];
  return new Set(matches.filter((token) => token.length > 1 || /[\u4e00-\u9fff]/u.test(token)));
}

export function overlapScore(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let hits = 0;
  for (const token of a) if (b.has(token)) hits += 1;
  return hits / Math.sqrt(a.size * b.size);
}

export function roundScore(value: number): number {
  return Math.round(value * 10000) / 10000;
}
