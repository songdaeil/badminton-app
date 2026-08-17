import type { Member, Match } from "@/app/types";

/** 실제로 기록된 점수. 빈칸·0-0은 경기가 시작되지 않은 것으로 본다. */
export function isRecordedScore(m: Pick<Match, "score1" | "score2">): boolean {
  return m.score1 != null && m.score2 != null && (m.score1 !== 0 || m.score2 !== 0);
}

export function gameHasRecordedScore(matches?: Match[] | null): boolean {
  return (matches ?? []).some(isRecordedScore);
}

/** 명단에만 있고 대진에 없는 사람이 있으면 true. 만든이가 대진을 다시 만들어야 함. */
export function rosterOutOfSyncWithDraw(members: Member[], matches: Match[]): boolean {
  if (matches.length === 0) return false;
  const inDraw = new Set<string>();
  for (const match of matches) {
    for (const p of match.team1.players) inDraw.add(p.id);
    for (const p of match.team2.players) inDraw.add(p.id);
  }
  return members.some((m) => !inDraw.has(m.id));
}

/** 내 연동 칸만 나의 프로필 멤버로 본다. 공유 문서의 myProfileMemberId(만든이 칸)를 쓰지 않는다. */
export function resolveMyProfileMemberId(
  members: Member[],
  uid: string | null | undefined,
  name?: string
): string | null {
  if (uid) {
    const linked = members.find((m) => m.linkedUid === uid);
    if (linked) return linked.id;
  }
  const trimmed = name?.trim();
  if (!trimmed) return null;
  const byName = members.find((m) => m.name === trimmed && (!m.linkedUid || m.linkedUid === uid));
  return byName?.id ?? null;
}

/** 내 프로필 멤버에만 이름·성별·급수 반영. 저장 시 단일 소스로 사용. */
export function applyMyProfileToMembers(
  members: Member[],
  myProfileMemberId: string | null,
  myInfo: { name?: string; gender?: "M" | "F"; grade?: string; uid?: string | null }
): Member[] {
  if (!myProfileMemberId) return members;
  return members.map((m) => {
    if (m.id !== myProfileMemberId) return m;
    if (m.linkedUid && myInfo.uid && m.linkedUid !== myInfo.uid) return m;
    return { ...m, name: myInfo.name ?? m.name, gender: (myInfo.gender as "M" | "F") ?? m.gender, grade: (myInfo.grade as Member["grade"]) ?? m.grade };
  });
}

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
