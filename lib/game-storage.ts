import type { Grade } from "@/app/types";
import type { Member, Match } from "@/app/types";

const LOCAL_KEY = "badminton-local";

export function getGameStorageKey(gameId: string | null): string {
  return gameId ? `game-${gameId}` : LOCAL_KEY;
}

/** 선택한 경기 방식 기준 설정: 언제, 어디서, 한 경기당 몇 점 */
export interface GameSettings {
  date: string; // YYYY-MM-DD
  time: string; // HH:mm
  location: string;
  scoreLimit: number; // 한 경기당 득점 제한 (15, 21, 30 등)
}

export const DEFAULT_GAME_SETTINGS: GameSettings = {
  date: "",
  time: "",
  location: "",
  scoreLimit: 21,
};

/** 앱 기준 나의 정보 (로그인 + 이름·성별·급수) - 경기별이 아닌 기기 로컬 저장 */
export interface MyInfo {
  name: string;
  /** M | F */
  gender: "M" | "F";
  /** A | B | C | D */
  grade: Grade;
  /** 카카오 프로필 이미지 URL (로그인 시) */
  profileImageUrl?: string;
  /** 카카오 이메일 (로그인 시, 표시용) */
  email?: string;
}

const MYINFO_KEY = "badminton-myinfo";
export const DEFAULT_MYINFO: MyInfo = { name: "", gender: "M", grade: "B" };

export function loadMyInfo(): MyInfo {
  if (typeof window === "undefined") return { ...DEFAULT_MYINFO };
  try {
    const raw = localStorage.getItem(MYINFO_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Record<string, unknown>;
      const name = typeof p.name === "string" ? p.name : "";
      const gender = p.gender === "F" ? "F" : "M";
      const grade = ["A", "B", "C", "D"].includes(p.grade as string) ? (p.grade as Grade) : "B";
      return {
        name,
        gender,
        grade,
        profileImageUrl: typeof p.profileImageUrl === "string" ? p.profileImageUrl : undefined,
        email: typeof p.email === "string" ? p.email : undefined,
      };
    }
  } catch {}
  return { ...DEFAULT_MYINFO };
}

export function saveMyInfo(info: MyInfo): void {
  if (typeof window === "undefined") return;
  const payload: Record<string, string> = { name: info.name, gender: info.gender, grade: info.grade };
  if (info.profileImageUrl) payload.profileImageUrl = info.profileImageUrl;
  if (info.email) payload.email = info.email;
  localStorage.setItem(MYINFO_KEY, JSON.stringify(payload));
}

export interface GameData {
  members: Member[];
  matches: Match[];
  /** 사용자 정의 경기 이름 (경기 목록 메인 표기) */
  gameName?: string | null;
  /** 경기 방식 id (선택된 경기 방식). 없으면 로드 시 기본값 사용 */
  gameMode?: string;
  /** 경기 설정 (언제, 어디서, 한 경기당 몇 점) */
  gameSettings?: GameSettings;
  /** 이 경기에서 '나'로 선택한 참가자 id (승률 통계용) */
  myProfileMemberId?: string | null;
  /** 전적에 추가된 시각 (경기 목록 표시용) */
  createdAt?: string | null;
  /** 경기을 만든 사람(멤버 id). 전적에 추가한 시점의 '나' */
  createdBy?: string | null;
  /** 경기을 만든 사람 이름 (멤버가 비어 있을 때 표시용) */
  createdByName?: string | null;
  /** 진행으로 체크된 매치 id 목록 (목록 나갔다 와도 유지) */
  playingMatchIds?: string[] | null;
}

const GAME_LIST_KEY = "badminton-game-list";

export function loadGameList(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(GAME_LIST_KEY);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr) && arr.every((x) => typeof x === "string")) return arr;
    }
  } catch {}
  return [];
}

export function saveGameList(ids: string[]): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(GAME_LIST_KEY, JSON.stringify(ids));
}

export function addGameToList(gameId: string): void {
  const ids = loadGameList();
  if (ids.includes(gameId)) return;
  saveGameList([...ids, gameId]);
}

/** 경기 목록에서 제거하고 해당 경기 저장 데이터 삭제 */
export function removeGameFromList(gameId: string): void {
  if (typeof window === "undefined") return;
  const ids = loadGameList().filter((id) => id !== gameId);
  saveGameList(ids);
  localStorage.removeItem(getGameStorageKey(gameId));
}

const DEFAULT_MEMBERS: Member[] = [
  { id: "1", name: "김철수", gender: "M", grade: "A", wins: 0, losses: 0, pointDiff: 0 },
  { id: "2", name: "이영희", gender: "F", grade: "A", wins: 0, losses: 0, pointDiff: 0 },
  { id: "3", name: "박민수", gender: "M", grade: "B", wins: 0, losses: 0, pointDiff: 0 },
  { id: "4", name: "최지연", gender: "F", grade: "B", wins: 0, losses: 0, pointDiff: 0 },
  { id: "5", name: "정대호", gender: "M", grade: "C", wins: 0, losses: 0, pointDiff: 0 },
  { id: "6", name: "한소희", gender: "F", grade: "C", wins: 0, losses: 0, pointDiff: 0 },
  { id: "7", name: "강동원", gender: "M", grade: "D", wins: 0, losses: 0, pointDiff: 0 },
  { id: "8", name: "윤서준", gender: "M", grade: "D", wins: 0, losses: 0, pointDiff: 0 },
  { id: "9", name: "임하늘", gender: "F", grade: "B", wins: 0, losses: 0, pointDiff: 0 },
];

export function loadGame(gameId: string | null): GameData {
  if (typeof window === "undefined") {
    return { members: DEFAULT_MEMBERS, matches: [], gameMode: undefined, gameSettings: { ...DEFAULT_GAME_SETTINGS }, myProfileMemberId: undefined };
  }
  const key = getGameStorageKey(gameId);
  try {
    const raw = localStorage.getItem(key);
    if (raw) {
      const parsed = JSON.parse(raw) as GameData;
      if (parsed && Array.isArray(parsed.members) && Array.isArray(parsed.matches)) {
        const settings = parsed.gameSettings;
        return {
          members: parsed.members.length > 0 ? parsed.members : DEFAULT_MEMBERS,
          matches: parsed.matches ?? [],
          gameName: typeof parsed.gameName === "string" ? parsed.gameName : undefined,
          gameMode: parsed.gameMode,
          gameSettings: settings
            ? {
                date: typeof settings.date === "string" ? settings.date : DEFAULT_GAME_SETTINGS.date,
                time: typeof settings.time === "string" ? settings.time : DEFAULT_GAME_SETTINGS.time,
                location: typeof settings.location === "string" ? settings.location : DEFAULT_GAME_SETTINGS.location,
                scoreLimit: typeof settings.scoreLimit === "number" && settings.scoreLimit > 0 ? settings.scoreLimit : DEFAULT_GAME_SETTINGS.scoreLimit,
              }
            : { ...DEFAULT_GAME_SETTINGS },
          myProfileMemberId: parsed.myProfileMemberId ?? undefined,
          createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : undefined,
          createdBy: typeof parsed.createdBy === "string" ? parsed.createdBy : undefined,
          createdByName: typeof parsed.createdByName === "string" ? parsed.createdByName : undefined,
          playingMatchIds: Array.isArray(parsed.playingMatchIds) && parsed.playingMatchIds.every((x) => typeof x === "string") ? parsed.playingMatchIds : undefined,
        };
      }
    }
  } catch {}
  if (gameId) {
    return { members: [], matches: [], gameMode: undefined, gameSettings: { ...DEFAULT_GAME_SETTINGS }, myProfileMemberId: undefined };
  }
  const legacyMembers = localStorage.getItem("badminton-members");
  if (legacyMembers) {
    try {
      const m = JSON.parse(legacyMembers) as Member[];
      if (Array.isArray(m) && m.length > 0) {
        return { members: m, matches: [], gameMode: undefined, gameSettings: { ...DEFAULT_GAME_SETTINGS }, myProfileMemberId: undefined };
      }
    } catch {}
  }
  return { members: DEFAULT_MEMBERS, matches: [], gameMode: undefined, gameSettings: { ...DEFAULT_GAME_SETTINGS }, myProfileMemberId: undefined };
}

export function saveGame(gameId: string | null, data: GameData): void {
  if (typeof window === "undefined") return;
  const key = getGameStorageKey(gameId);
  localStorage.setItem(
    key,
    JSON.stringify({
      members: data.members,
      matches: data.matches,
      gameName: data.gameName ?? null,
      gameMode: data.gameMode,
      gameSettings: data.gameSettings ?? DEFAULT_GAME_SETTINGS,
      myProfileMemberId: data.myProfileMemberId ?? null,
      createdAt: data.createdAt ?? null,
      createdBy: data.createdBy ?? null,
      createdByName: data.createdByName ?? null,
      playingMatchIds: data.playingMatchIds ?? null,
    })
  );
}

export function createGameId(): string {
  return Math.random().toString(36).slice(2, 10);
}
