/** 회원: 이름, 성별, 급수, 승/패, 총 점수 득실 */
export type Grade = "A" | "B" | "C" | "D";
export type Gender = "M" | "F";

export interface Member {
  id: string;
  name: string;
  gender: Gender;
  grade: Grade;
  wins: number;
  losses: number;
  pointDiff: number; // 총 점수 득실 (득점 - 실점)
}

/** 한 팀 = 2명 */
export interface Team {
  id: string;
  players: [Member, Member];
}

/** 경기 방식: id, 표시명, 참가 인원 범위, 경기 설정에 영향을 주는 옵션 (향후 확장용) */
export interface GameMode {
  id: string;
  label: string;
  /** 상단 카테고리 탭 분류용. 없으면 'other'로 묶음 */
  categoryId?: string;
  minPlayers: number;
  maxPlayers: number;
  /** 해당 방식의 기본 한 경기당 득점 제한. 없으면 21 */
  defaultScoreLimit?: number;
  /** 해당 방식에서 선택 가능한 한 경기당 점수 옵션. 없으면 [15, 21, 30] */
  scoreLimitOptions?: number[];
}

/** 저장/수정 이력 한 건: 시점과 저장자(로그인한 사람 이름) */
export interface SavedRecord {
  at: string; // ISO 시각
  by: string; // 호환용 멤버 id
  savedByName?: string | null; // 저장 시점의 로그인한 사람 이름 (저장자)
}

/** 한 매치 = 팀1 vs 팀2, 점수(선택), 저장 시각·계정·이력 */
export interface Match {
  id: string;
  team1: Team;
  team2: Team;
  score1: number | null; // 팀1 득점
  score2: number | null; // 팀2 득점
  savedAt?: string | null; // 마지막 저장 시각 ISO (호환용)
  savedBy?: string | null; // 마지막 저장한 멤버 id
  savedHistory?: SavedRecord[]; // 완료/수정 시점·계정 이력 (오른쪽 여백 표시용)
}
