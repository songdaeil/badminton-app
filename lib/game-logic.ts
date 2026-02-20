import type { GameMode, Member, Match } from "@/app/types";

// ---------------------------------------------------------------------------
// 경기 방식 설정 (경기 방식 탭·경기 생성 공통)
// ---------------------------------------------------------------------------

/** 경기 방식 목록. 선택한 방식이 경기 설정(한 경기당 몇 점 등)에 반영됨 */
export const GAME_MODES: GameMode[] = [
  {
    id: "individual",
    label: "개인전a",
    categoryId: "doubles",
    minPlayers: 4,
    maxPlayers: 12,
    defaultScoreLimit: 21,
    scoreLimitOptions: [15, 21, 30],
  },
  {
    id: "individual_b",
    label: "개인전b",
    categoryId: "doubles",
    minPlayers: 4,
    maxPlayers: 12,
    defaultScoreLimit: 21,
    scoreLimitOptions: [15, 21, 30],
  },
];

/** 인원수별 목표 총 경기 수 (인당 경기 수 동일·공정) */
export const TARGET_TOTAL_GAMES_TABLE: Record<number, number> = {
  4: 3,
  5: 5,
  6: 9,
  7: 14,
  8: 14,
  9: 18,
  10: 20,
  11: 33,
  12: 33,
};

/** 급수 순서 (랭킹 정렬용) */
export const GRADE_ORDER = { A: 0, B: 1, C: 2, D: 3 } as const;

/** 개인전 목표 총 경기 수. 테이블 값 사용 → 경기 생성 결과와 항상 일치. */
export function getTargetTotalGames(n: number): number {
  if (n < 4 || n > 12) return 0;
  return TARGET_TOTAL_GAMES_TABLE[n] ?? 0;
}

// ---------------------------------------------------------------------------
// 대진표 생성 로직 (라운드로빈, 인당 경기 수 동일)
// ---------------------------------------------------------------------------

function createId(): string {
  return Math.random().toString(36).slice(2, 11);
}

function pairKey(i: number, j: number): string {
  return i < j ? `${i},${j}` : `${j},${i}`;
}

/**
 * 개인전 대진 생성: 테이블의 총 경기 수 정확히 맞춤. 인당 경기 수 동일(공정).
 * 파트너·상대팀 돌아가며 배치하며 중복 최소화(그리디).
 */
export function buildRoundRobinMatches(members: Member[], targetTotal: number): Match[] {
  const n = members.length;
  if (n < 4 || targetTotal <= 0) return [];
  const perPlayer = (targetTotal * 4) / n;
  if (perPlayer !== Math.floor(perPlayer)) return [];

  const appearances = new Array<number>(n).fill(0);
  const partnerCount = new Map<string, number>();
  const opponentCount = new Map<string, number>();
  const selected: { pair1: [number, number]; pair2: [number, number] }[] = [];

  const getPartner = (a: number, b: number) => partnerCount.get(pairKey(a, b)) ?? 0;
  const getOpponent = (a: number, b: number) => opponentCount.get(pairKey(a, b)) ?? 0;

  for (let step = 0; step < targetTotal; step++) {
    let best: { a: number; b: number; c: number; d: number } | null = null;
    let bestScore = Infinity;

    for (let a = 0; a < n; a++) {
      for (let b = a + 1; b < n; b++) {
        if (appearances[a] >= perPlayer || appearances[b] >= perPlayer) continue;
        for (let c = 0; c < n; c++) {
          if (c === a || c === b) continue;
          for (let d = c + 1; d < n; d++) {
            if (d === a || d === b) continue;
            if (appearances[c] >= perPlayer || appearances[d] >= perPlayer) continue;
            const partnerScore = getPartner(a, b) + getPartner(c, d);
            const oppScore =
              getOpponent(a, c) + getOpponent(a, d) + getOpponent(b, c) + getOpponent(b, d);
            const after = [...appearances];
            after[a]++;
            after[b]++;
            after[c]++;
            after[d]++;
            const range = Math.max(...after) - Math.min(...after);
            const score = partnerScore * 2 + oppScore + range * 100;
            if (score < bestScore) {
              bestScore = score;
              best = { a, b, c, d };
            }
          }
        }
      }
    }

    if (!best) break;
    const { a, b, c, d } = best;
    selected.push({ pair1: [a, b], pair2: [c, d] });
    appearances[a]++;
    appearances[b]++;
    appearances[c]++;
    appearances[d]++;
    partnerCount.set(pairKey(a, b), getPartner(a, b) + 1);
    partnerCount.set(pairKey(c, d), getPartner(c, d) + 1);
    for (const x of [a, b]) {
      for (const y of [c, d]) opponentCount.set(pairKey(x, y), getOpponent(x, y) + 1);
    }
  }

  return selected.map(({ pair1: [a, b], pair2: [c, d] }) => ({
    id: createId(),
    team1: { id: createId(), players: [members[a], members[b]] },
    team2: { id: createId(), players: [members[c], members[d]] },
    score1: null,
    score2: null,
    savedAt: null,
    savedBy: null,
    savedHistory: [],
  }));
}

/** 경기 방식에 따른 경기 생성 단일 진입점. 경기 목록 "경기 생성" 시 이 함수만 사용. */
export function generateMatchesByGameMode(gameModeId: string, members: Member[]): Match[] {
  if (gameModeId === "individual" || gameModeId === "individual_b") {
    const target = getTargetTotalGames(members.length);
    return buildRoundRobinMatches(members, target);
  }
  return [];
}
