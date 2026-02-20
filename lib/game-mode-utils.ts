import {
  GAME_MODES,
  GRADE_ORDER,
  TARGET_TOTAL_GAMES_TABLE,
  getTargetTotalGames,
  buildRoundRobinMatches,
  generateMatchesByGameMode,
} from "@/lib/game-logic";

export { GAME_MODES, GRADE_ORDER, TARGET_TOTAL_GAMES_TABLE, getTargetTotalGames, buildRoundRobinMatches, generateMatchesByGameMode };

/** 21점 1경기당 예상 소요 시간(분) */
export const MINUTES_PER_21PT_GAME = 15;

export const MIN_COURTS = 1;
export const MAX_COURTS = 2;

/** 시간 옵션 (30분 단위) */
export const TIME_OPTIONS_30MIN: string[] = (() => {
  const opts: string[] = [];
  for (let h = 0; h < 24; h++) {
    opts.push(`${h.toString().padStart(2, "0")}:00`, `${h.toString().padStart(2, "0")}:30`);
  }
  return opts;
})();

export function createId(): string {
  return Math.random().toString(36).slice(2, 11);
}

/** 저장 시각 표시 (M/D HH:mm:ss) */
export function formatSavedAt(iso?: string | null): string {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}:${d.getSeconds().toString().padStart(2, "0")}`;
  } catch {
    return "";
  }
}

export function canUseParallelCourts(players: number): boolean {
  return players >= 8;
}

export function getRecommendedCourts(players: number): number {
  return canUseParallelCourts(players) ? MAX_COURTS : MIN_COURTS;
}

export function getMinCourts(_players: number): number {
  return MIN_COURTS;
}

export function getMaxCourts(players: number): number {
  return canUseParallelCourts(players) ? MAX_COURTS : MIN_COURTS;
}

/** 분 단위 → "N분" / "N시간 M분" */
export function formatEstimatedDuration(totalMinutes: number): string {
  if (totalMinutes < 60) return `${totalMinutes}분`;
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return m > 0 ? `${h}시간 ${m}분` : `${h}시간`;
}

