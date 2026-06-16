import { SkillMarketEntry } from './skill-market.types';
import { overlapScore, roundScore, tokenizeSkillText } from './skill-market.text';

export interface RankedSkill {
  entry: SkillMarketEntry;
  score: number;
}

export class SkillRanker {
  rank(query: string, entries: SkillMarketEntry[], topK: number): RankedSkill[] {
    const queryTokens = tokenizeSkillText(query);
    return entries
      .filter((entry) => !entry.disabledForModel)
      .map((entry) => ({ entry, score: scoreEntry(queryTokens, entry) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || a.entry.skillId.localeCompare(b.entry.skillId))
      .slice(0, topK);
  }
}

function scoreEntry(queryTokens: Set<string>, entry: SkillMarketEntry): number {
  const nameScore = overlapScore(queryTokens, tokenizeSkillText(entry.name));
  const descriptionScore = overlapScore(queryTokens, tokenizeSkillText(entry.description));
  const whenToUseScore = overlapScore(queryTokens, tokenizeSkillText(entry.whenToUse ?? ''));
  return roundScore(0.45 * nameScore + 0.4 * descriptionScore + 0.15 * whenToUseScore);
}
