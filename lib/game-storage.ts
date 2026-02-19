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

/** 앱 기준 나의 정보 (로그인 + 프로필) - 경기별이 아닌 기기 로컬 저장 */
export interface MyInfo {
  name: string;
  /** M | F */
  gender: "M" | "F";
  /** 급수 A|B|C|D */
  grade?: "A" | "B" | "C" | "D";
  /** 프로필 이미지 URL (직접 입력 또는 업로드 후 URL) */
  profileImageUrl?: string;
  /** 이메일 로그인 시 표시용 */
  email?: string;
  /** 전화번호 (로그인 시 자동 채움, 프로필에서 수정 가능) */
  phoneNumber?: string;
  /** 생년월일 YYYY-MM-DD */
  birthDate?: string;
  /** Firebase Auth UID. 로그인 시 프로필에 내포 → 경기 명단 '프로필로 나 추가' 시 이 UID로 연동(linkedUid) */
  uid?: string;
}

const MYINFO_KEY = "badminton-myinfo";
export const DEFAULT_MYINFO: MyInfo = { name: "", gender: "M", grade: "D" };

export function loadMyInfo(): MyInfo {
  if (typeof window === "undefined") return { ...DEFAULT_MYINFO };
  try {
    const raw = localStorage.getItem(MYINFO_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Record<string, unknown>;
      const name = typeof p.name === "string" ? p.name : "";
      const gender = p.gender === "F" ? "F" : "M";
      const grade = p.grade === "A" || p.grade === "B" || p.grade === "C" ? p.grade : "D";
      return {
        name,
        gender,
        grade,
        profileImageUrl: typeof p.profileImageUrl === "string" ? p.profileImageUrl : undefined,
        email: typeof p.email === "string" ? p.email : undefined,
        phoneNumber: typeof p.phoneNumber === "string" ? p.phoneNumber : undefined,
        birthDate: typeof p.birthDate === "string" ? p.birthDate : undefined,
        uid: typeof p.uid === "string" ? p.uid : undefined,
      };
    }
  } catch {}
  return { ...DEFAULT_MYINFO };
}

export function saveMyInfo(info: MyInfo): void {
  if (typeof window === "undefined") return;
  const payload: Record<string, string> = { name: info.name, gender: info.gender };
  if (info.grade) payload.grade = info.grade;
  if (info.profileImageUrl) payload.profileImageUrl = info.profileImageUrl;
  if (info.email) payload.email = info.email;
  if (info.phoneNumber) payload.phoneNumber = info.phoneNumber;
  if (info.birthDate) payload.birthDate = info.birthDate;
  if (info.uid) payload.uid = info.uid;
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
  /** 최초 생성자 유니크 ID (Firebase UID). 누가 최초로 만들었는지 구분용 */
  createdByUid?: string | null;
  /** 진행으로 체크된 매치 id 목록 (목록 나갔다 와도 유지) */
  playingMatchIds?: string[] | null;
  /** 이 경기를 불러올 때 사용한 공유 쿼리(?share=xxx). 동일 링크 재진입 시 중복 추가 방지용 */
  importedFromShare?: string | null;
  /** 실시간 동기화용 Firestore 문서 id. 있으면 이 경기는 공유 문서와 동기화됨 */
  shareId?: string | null;
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

export function loadGame(gameId: string | null): GameData {
  if (typeof window === "undefined") {
    return { members: [], matches: [], gameMode: undefined, gameSettings: { ...DEFAULT_GAME_SETTINGS }, myProfileMemberId: undefined };
  }
  const key = getGameStorageKey(gameId);
  try {
    const raw = localStorage.getItem(key);
    if (raw) {
      const parsed = JSON.parse(raw) as GameData;
      if (parsed && Array.isArray(parsed.members) && Array.isArray(parsed.matches)) {
        const settings = parsed.gameSettings;
        return {
          members: parsed.members,
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
          createdByUid: typeof parsed.createdByUid === "string" ? parsed.createdByUid : undefined,
          playingMatchIds: Array.isArray(parsed.playingMatchIds) && parsed.playingMatchIds.every((x) => typeof x === "string") ? parsed.playingMatchIds : undefined,
          importedFromShare: typeof parsed.importedFromShare === "string" ? parsed.importedFromShare : undefined,
          shareId: typeof parsed.shareId === "string" ? parsed.shareId : undefined,
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
  return { members: [], matches: [], gameMode: undefined, gameSettings: { ...DEFAULT_GAME_SETTINGS }, myProfileMemberId: undefined };
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
      createdByUid: data.createdByUid ?? null,
      playingMatchIds: data.playingMatchIds ?? null,
      importedFromShare: data.importedFromShare ?? null,
      shareId: data.shareId ?? null,
    })
  );
}

export function createGameId(): string {
  return Math.random().toString(36).slice(2, 10);
}
