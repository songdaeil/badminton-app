import type { Member, Match } from "@/app/types";

/** 저장된 경기(score1/score2 있는 것)만으로 멤버별 승/패/득실차 재계산 → 경기 명단 state 갱신용 */
export function recomputeMemberStatsFromMatches(members: Member[], matches: Match[]): Member[] {
  const stats: Record<string, { wins: number; losses: number; pointDiff: number }> = {};
  for (const m of members) stats[m.id] = { wins: 0, losses: 0, pointDiff: 0 };
  for (const match of matches) {
    if (match.score1 == null || match.score2 == null) continue;
    const s1 = match.score1;
    const s2 = match.score2;
    if (s1 === 0 && s2 === 0) continue;
    if (s1 === s2) continue;
    const diff = Math.abs(s1 - s2);
    const team1Won = s1 > s2;
    for (const p of match.team1.players) {
      if (stats[p.id]) {
        stats[p.id].wins += team1Won ? 1 : 0;
        stats[p.id].losses += team1Won ? 0 : 1;
        stats[p.id].pointDiff += team1Won ? diff : -diff;
      }
    }
    for (const p of match.team2.players) {
      if (stats[p.id]) {
        stats[p.id].wins += team1Won ? 0 : 1;
        stats[p.id].losses += team1Won ? 1 : 0;
        stats[p.id].pointDiff += team1Won ? -diff : diff;
      }
    }
  }
  return members.map((m) => ({
    ...m,
    wins: stats[m.id]?.wins ?? 0,
    losses: stats[m.id]?.losses ?? 0,
    pointDiff: stats[m.id]?.pointDiff ?? 0,
  }));
}

/** 경기 결과 전용: 경기 현황(matches)만으로 참가 멤버와 승/패/득실차 산출 */
export function buildRankingFromMatchesOnly(
  matches: Match[],
  gradeOrder: Record<string, number>
): Member[] {
  const byId = new Map<string, Member>();
  const stats: Record<string, { wins: number; losses: number; pointDiff: number }> = {};
  for (const match of matches) {
    for (const p of match.team1.players) {
      if (!byId.has(p.id)) {
        byId.set(p.id, { ...p, wins: 0, losses: 0, pointDiff: 0 });
        stats[p.id] = { wins: 0, losses: 0, pointDiff: 0 };
      }
    }
    for (const p of match.team2.players) {
      if (!byId.has(p.id)) {
        byId.set(p.id, { ...p, wins: 0, losses: 0, pointDiff: 0 });
        stats[p.id] = { wins: 0, losses: 0, pointDiff: 0 };
      }
    }
  }
  for (const match of matches) {
    if (match.score1 == null || match.score2 == null) continue;
    const s1 = match.score1;
    const s2 = match.score2;
    if (s1 === 0 && s2 === 0) continue;
    if (s1 === s2) continue;
    const diff = Math.abs(s1 - s2);
    const team1Won = s1 > s2;
    for (const p of match.team1.players) {
      if (stats[p.id]) {
        stats[p.id].wins += team1Won ? 1 : 0;
        stats[p.id].losses += team1Won ? 0 : 1;
        stats[p.id].pointDiff += team1Won ? diff : -diff;
      }
    }
    for (const p of match.team2.players) {
      if (stats[p.id]) {
        stats[p.id].wins += team1Won ? 0 : 1;
        stats[p.id].losses += team1Won ? 1 : 0;
        stats[p.id].pointDiff += team1Won ? -diff : diff;
      }
    }
  }
  const list = Array.from(byId.values()).map((m) => ({
    ...m,
    wins: stats[m.id]?.wins ?? 0,
    losses: stats[m.id]?.losses ?? 0,
    pointDiff: stats[m.id]?.pointDiff ?? 0,
  }));
  return list.sort((a, b) => {
    if (b.wins !== a.wins) return b.wins - a.wins;
    if (b.pointDiff !== a.pointDiff) return b.pointDiff - a.pointDiff;
    return (gradeOrder[a.grade] ?? 0) - (gradeOrder[b.grade] ?? 0);
  });
}
