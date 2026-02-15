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

/** 한 매치 = 팀1 vs 팀2, 점수(선택), 저장 시각 */
export interface Match {
  id: string;
  team1: Team;
  team2: Team;
  score1: number | null; // 팀1 득점
  score2: number | null; // 팀2 득점
  savedAt?: string | null; // 저장한 시각 ISO 문자열 (업데이트 확인용)
}
