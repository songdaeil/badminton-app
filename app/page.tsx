"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { addGameToList, createGameId, DEFAULT_GAME_SETTINGS, DEFAULT_MYINFO, loadGame, loadGameList, loadMyInfo, removeGameFromList, saveGame, saveMyInfo } from "@/lib/game-storage";
import type { GameData, GameSettings, MyInfo } from "@/lib/game-storage";
import { ensureFirebase, getDb } from "@/lib/firebase";
import { addSharedGame, getFirestorePayloadSize, getSharedGame, isSyncAvailable, setSharedGame, subscribeSharedGame } from "@/lib/sync";
import { getKakaoJsKey, initKakao, loginWithKakao, logoutKakao } from "@/lib/kakao";
import type { GameMode, Grade, Member, Match } from "./types";

/** 공유 링크용 경기 데이터 직렬화 (base64url) - 만든 이 정보 포함 */
function encodeGameForShare(data: GameData): string {
  const payload = {
    members: data.members,
    matches: data.matches,
    gameName: data.gameName ?? undefined,
    gameMode: data.gameMode,
    gameSettings: data.gameSettings ?? DEFAULT_GAME_SETTINGS,
    myProfileMemberId: data.myProfileMemberId ?? undefined,
    createdAt: data.createdAt ?? undefined,
    createdBy: data.createdBy ?? undefined,
    createdByName: data.createdByName ?? undefined,
  };
  const json = JSON.stringify(payload);
  const base64 = btoa(encodeURIComponent(json));
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** 공유 링크에서 경기 데이터 복원 */
function decodeGameFromShare(encoded: string): GameData | null {
  try {
    const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    const json = decodeURIComponent(atob(padded));
    const p = JSON.parse(json) as GameData;
    if (!p || !Array.isArray(p.members) || !Array.isArray(p.matches)) return null;
    return {
      members: p.members,
      matches: p.matches,
      gameName: p.gameName ?? undefined,
      gameMode: p.gameMode,
      gameSettings: p.gameSettings ?? { ...DEFAULT_GAME_SETTINGS },
      myProfileMemberId: p.myProfileMemberId ?? undefined,
      createdAt: typeof p.createdAt === "string" ? p.createdAt : undefined,
      createdBy: typeof p.createdBy === "string" ? p.createdBy : undefined,
      createdByName: typeof p.createdByName === "string" ? p.createdByName : undefined,
    };
  } catch {
    return null;
  }
}

/** 저장된 경기(score1/score2 있는 것)만으로 멤버별 승/패/득실차 재계산 → 경기 결과와 항상 일치 */
function recomputeMemberStatsFromMatches(members: Member[], matches: Match[]): Member[] {
  const stats: Record<string, { wins: number; losses: number; pointDiff: number }> = {};
  for (const m of members) stats[m.id] = { wins: 0, losses: 0, pointDiff: 0 };
  for (const match of matches) {
    if (match.score1 == null || match.score2 == null) continue;
    const s1 = match.score1;
    const s2 = match.score2;
    if (s1 === 0 && s2 === 0) continue; // 0:0은 미입력으로 간주, 승패 미반영
    if (s1 === s2) continue; // 동점은 승패 미반영
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

/** 경기 방식 카테고리 (상단 탭). 이미지 참고: 복식/단식/대항전/단체 등 */
const GAME_CATEGORIES = [
  { id: "doubles", label: "복식" },
  { id: "singles", label: "단식" },
  { id: "contest", label: "대항전" },
  { id: "team", label: "단체" },
] as const;

/** 경기 방식 목록. 선택한 방식이 경기 설정(한 경기당 몇 점 등)에 반영됨 */
const GAME_MODES: GameMode[] = [
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

const PRIMARY = "#0071e3";
const PRIMARY_LIGHT = "rgba(0, 113, 227, 0.08)";

const GRADE_ORDER: Record<Grade, number> = { A: 0, B: 1, C: 2, D: 3 };

/** 21점 1경기당 예상 소요 시간(분). 소요시간 표시용 */
const MINUTES_PER_21PT_GAME = 15;

/** 코트 수: 최소 1, 병렬 진행 가능 시 최대 2 */
const MIN_COURTS = 1;
const MAX_COURTS = 2;

/** 병렬 조건: 인원이 많아 동시에 두 경기 돌리기 적당하면 추가 코트 반영 (8명 이상) */
function canUseParallelCourts(players: number): boolean {
  return players >= 8;
}

function getRecommendedCourts(players: number): number {
  return canUseParallelCourts(players) ? MAX_COURTS : MIN_COURTS;
}

function getMinCourts(_players: number): number {
  return MIN_COURTS;
}

function getMaxCourts(players: number): number {
  return canUseParallelCourts(players) ? MAX_COURTS : MIN_COURTS;
}

// ---------------------------------------------------------------------------
// 개인전 (4~12명) 경기 생성 로직 — 핵심 단일 소스
// 1. 파트너 돌아가며 배치, 중복 최소화
// 2. 상대팀 돌아가며 배치, 중복 최소화
// 3. 인원·총 경기 수·인당 경기 수는 아래 테이블 준수 (인당 경기 수 = 동일하게 공정)
// 4. 경기 방식 섹션 테이블과 경기 목록 "경기 생성"이 동일 로직 사용
// ---------------------------------------------------------------------------

/** 인원수별 목표 총 경기 수 (사용자 지정 테이블). 인당 경기 수 = (총 경기 수 * 4) / 인원 → 반드시 동일. */
const TARGET_TOTAL_GAMES_TABLE: Record<number, number> = {
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

/** 분 단위를 "N분" / "N시간 M분"으로 표시 */
function formatEstimatedDuration(totalMinutes: number): string {
  if (totalMinutes < 60) return `${totalMinutes}분`;
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return m > 0 ? `${h}시간 ${m}분` : `${h}시간`;
}

/** 30분 단위 시작 시간 옵션 (00:00 ~ 23:30) */
const TIME_OPTIONS_30MIN: string[] = (() => {
  const opts: string[] = [];
  for (let h = 0; h < 24; h++) {
    opts.push(`${h.toString().padStart(2, "0")}:00`, `${h.toString().padStart(2, "0")}:30`);
  }
  return opts;
})();

function createId() {
  return Math.random().toString(36).slice(2, 11);
}

/** 저장 시각을 짧게 표시 (M/D HH:mm) */
function formatSavedAt(iso?: string | null): string {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
  } catch {
    return "";
  }
}

/** 개인전 목표 총 경기 수. 테이블 값 사용 → 경기 생성 결과와 항상 일치. 인당 경기 수 = (total*4)/n (동일·공정). */
function getTargetTotalGames(n: number): number {
  if (n < 4 || n > 12) return 0;
  return TARGET_TOTAL_GAMES_TABLE[n] ?? 0;
}

function pairKey(i: number, j: number): string {
  return i < j ? `${i},${j}` : `${j},${i}`;
}

/**
 * 개인전 대진 생성: 테이블의 총 경기 수 정확히 맞춤. 인당 경기 수 동일(공정).
 * 파트너·상대팀 돌아가며 배치하며 중복 최소화(그리디).
 */
function buildRoundRobinMatches(members: Member[], targetTotal: number): Match[] {
  const n = members.length;
  if (n < 4 || targetTotal <= 0) return [];
  const perPlayer = (targetTotal * 4) / n;
  if (perPlayer !== Math.floor(perPlayer)) return []; // 불가능한 조합 방지

  const appearances = new Array<number>(n).fill(0);
  const partnerCount = new Map<string, number>();
  const opponentCount = new Map<string, number>();
  const selected: { pair1: [number, number]; pair2: [number, number] }[] = [];

  function getPartner(a: number, b: number): number {
    return partnerCount.get(pairKey(a, b)) ?? 0;
  }
  function getOpponent(a: number, b: number): number {
    return opponentCount.get(pairKey(a, b)) ?? 0;
  }

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
      for (const y of [c, d]) {
        const k = pairKey(x, y);
        opponentCount.set(k, getOpponent(x, y) + 1);
      }
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

/**
 * 선정한 경기 방식에 따라 경기를 생성하는 단일 진입점.
 * 경기 목록에서 "경기 생성" 시 반드시 이 함수만 사용하여, 경기 방식 섹션에서 정의한 로직과 일치시킴.
 */
function generateMatchesByGameMode(gameModeId: string, members: Member[]): Match[] {
  if (gameModeId === "individual") {
    const target = getTargetTotalGames(members.length);
    return buildRoundRobinMatches(members, target);
  }
  if (gameModeId === "individual_b") {
    // 개인전b 전용 경기 생성 로직 (추후 규칙에 맞게 구현)
    return [];
  }
  return [];
}

const MAX_MEMBERS = 12;

function AddMemberForm({
  onAdd,
  primaryColor,
  membersCount = 0,
  maxMembers = MAX_MEMBERS,
}: {
  onAdd: (name: string, gender: "M" | "F", grade: Grade) => void;
  primaryColor: string;
  membersCount?: number;
  maxMembers?: number;
}) {
  const [name, setName] = useState("");
  const [gender, setGender] = useState<"M" | "F">("M");
  const [grade, setGrade] = useState<Grade>("B");
  const atLimit = membersCount >= maxMembers;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (atLimit) return;
    onAdd(name, gender, grade);
    setName("");
  };

  return (
    <form onSubmit={handleSubmit} className="flex flex-wrap items-end gap-1.5">
      <div className="flex-1 min-w-0">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="이름"
          aria-label="이름"
          className="w-full px-2 py-1.5 rounded-xl border border-[#d2d2d7] bg-[#fbfbfd] text-[#1d1d1f] placeholder:text-[#6e6e73] text-sm focus:outline-none focus:ring-2 focus:ring-[#0071e3]/25 focus:border-[#0071e3]"
        />
      </div>
      <select
        value={gender}
        onChange={(e) => setGender(e.target.value as "M" | "F")}
        aria-label="성별"
        className="shrink-0 w-14 px-1.5 py-1.5 rounded-xl border border-[#d2d2d7] bg-[#fbfbfd] text-[#1d1d1f] text-sm focus:outline-none focus:ring-2 focus:ring-[#0071e3]/25 focus:border-[#0071e3]"
      >
        <option value="M">남</option>
        <option value="F">여</option>
      </select>
      <select
        value={grade}
        onChange={(e) => setGrade(e.target.value as Grade)}
        aria-label="급수"
        className="shrink-0 w-12 px-1.5 py-1.5 rounded-xl border border-[#d2d2d7] bg-[#fbfbfd] text-[#1d1d1f] text-sm focus:outline-none focus:ring-2 focus:ring-[#0071e3]/25 focus:border-[#0071e3]"
      >
        <option value="A">A</option>
        <option value="B">B</option>
        <option value="C">C</option>
        <option value="D">D</option>
      </select>
      <button
        type="submit"
        disabled={atLimit}
        className="shrink-0 py-1.5 px-3 rounded-lg font-medium text-white text-sm hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
        style={{ backgroundColor: primaryColor }}
      >
        추가
      </button>
      {atLimit && <p className="w-full text-xs text-slate-400">경기 인원은 최대 {maxMembers}명까지입니다.</p>}
    </form>
  );
}

export function GameView({ gameId }: { gameId: string | null }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [members, setMembers] = useState<Member[]>([]);
  const [matches, setMatches] = useState<Match[]>([]);
  const [scoreInputs, setScoreInputs] = useState<Record<string, { s1: string; s2: string }>>({});
  const [mounted, setMounted] = useState(false);
  /** 사용자 정의 경기 이름 (경기 목록 메인 표기) */
  const [gameName, setGameName] = useState<string>("");
  /** 선택된 경기 방식 id (저장·로드 반영) */
  const [gameModeId, setGameModeId] = useState<string>(GAME_MODES[0].id);
  /** 경기 방식 카테고리 탭 (복식/단식/대항전/단체/기타) */
  const [gameModeCategoryId, setGameModeCategoryId] = useState<string>(() => GAME_MODES[0].categoryId ?? GAME_CATEGORIES[0].id);
  /** 경기 설정: 언제, 어디서, 한 경기당 몇 점 (선택한 경기 방식 기준) */
  const [gameSettings, setGameSettings] = useState<GameSettings>(() => ({ ...DEFAULT_GAME_SETTINGS }));
  /** 사용자가 선택한 '진행중' 매치 id 목록 (여러 코트 병렬 진행 가능) */
  const [selectedPlayingMatchIds, setSelectedPlayingMatchIds] = useState<string[]>([]);
  /** 하단 네비로 이동하는 화면: setting(경기 세팅) | record(경기 목록) | myinfo(나의 정보) */
  const [navView, setNavView] = useState<"setting" | "record" | "myinfo">("setting");
  /** 경기 목록에서 선택한 경기 id (목록에서 하나 고르면 이 경기 로드) */
  const [selectedGameId, setSelectedGameId] = useState<string | null>(null);
  /** 경기 목록 카드별 ... 메뉴 열린 카드 id */
  const [listMenuOpenId, setListMenuOpenId] = useState<string | null>(null);
  /** 공유 링크 복사 완료 메시지 (잠깐 표시) */
  const [shareToast, setShareToast] = useState<string | null>(null);
  /** 경기 방식 도움말 팝업 */
  const [showGameModeHelp, setShowGameModeHelp] = useState(false);
  /** 경기 목록 도움말 팝업 */
  const [showRecordHelp, setShowRecordHelp] = useState(false);
  /** 앱 기준 나의 정보 (로그인, 클럽) - 로컬 저장 */
  const [myInfo, setMyInfo] = useState<MyInfo>(() => ({ ...DEFAULT_MYINFO }));
  /** 이 경기에서 '나'로 선택한 참가자 id (승률 통계용) */
  const [myProfileMemberId, setMyProfileMemberId] = useState<string | null>(null);
  /** 경기 목록에서 이름 클릭 시 하이라이트할 멤버 id (파트너/상대 직관 확인용) */
  const [highlightMemberId, setHighlightMemberId] = useState<string | null>(null);
  /** 카카오 로그인 진행 중 / 메시지 */
  const [kakaoLoginStatus, setKakaoLoginStatus] = useState<string | null>(null);
  /** 경기 생성 전 확인 모달 (종료/진행 중인 경기 있을 때) */
  const [showRegenerateConfirm, setShowRegenerateConfirm] = useState(false);
  /** Firestore에서 내려온 데이터 적용 시 다음 save 시 Firestore 업로드 스킵 */
  const skipNextFirestorePush = useRef(false);
  /** Firestore 업로드 디바운스 (편집 시 매 입력마다 업로드하지 않도록) */
  const firestorePushTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 저장(로컬+Firestore) 디바운스용: 마지막 payload와 타이머. 편집 시 렉 방지 */
  const saveDebounceRef = useRef<{ id: string; payload: GameData } | null>(null);
  const saveDebounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const SAVE_DEBOUNCE_MS = 400;
  /** 구독으로 원격 데이터 적용 시, 입력 중인 점수(미저장)를 덮어쓰지 않도록 최신 scoreInputs 참조 */
  const scoreInputsRef = useRef<Record<string, { s1: string; s2: string }>>({});
  useEffect(() => {
    scoreInputsRef.current = scoreInputs;
  }, [scoreInputs]);
  /** 경기 목록에서 공유(shareId) 카드 최신 데이터 갱신 후 리스트 다시 그리기용 */
  const [listRefreshKey, setListRefreshKey] = useState(0);
  /** 방금 Firestore에 업로드한 용량(바이트). 공유 경기 열람 시 표시 */
  const [lastFirestoreUploadBytes, setLastFirestoreUploadBytes] = useState<number | null>(null);
  const effectiveGameId = gameId ?? selectedGameId;
  const gameMode = GAME_MODES.find((m) => m.id === gameModeId) ?? GAME_MODES[0];
  /** 테이블 내 직접입력 행: 새 참가자 입력값 */
  const [newMemberName, setNewMemberName] = useState("");
  const [newMemberGender, setNewMemberGender] = useState<"M" | "F">("M");
  const [newMemberGrade, setNewMemberGrade] = useState<Grade>("B");

  useEffect(() => {
    if (effectiveGameId === null) {
      setMembers([]);
      setMatches([]);
      setGameName("");
      setGameModeId(GAME_MODES[0].id);
      setGameModeCategoryId(GAME_MODES[0].categoryId ?? GAME_CATEGORIES[0].id);
      setGameSettings({ ...DEFAULT_GAME_SETTINGS });
      setScoreInputs({});
      setSelectedPlayingMatchIds([]);
      setMyProfileMemberId(null);
      setHighlightMemberId(null);
      setMounted(true);
      return;
    }
    const data = loadGame(effectiveGameId);
    const membersWithCorrectStats = recomputeMemberStatsFromMatches(data.members, data.matches);
    setMembers(membersWithCorrectStats);
    setGameName(typeof data.gameName === "string" && data.gameName.trim() ? data.gameName.trim() : "");
    setMatches(data.matches);
    setMyProfileMemberId(
      data.myProfileMemberId ?? data.members.find((m) => m.name === "송대일")?.id ?? null
    );
    const loadedModeId = data.gameMode && GAME_MODES.some((m) => m.id === data.gameMode) ? data.gameMode! : GAME_MODES[0].id;
    setGameModeId(loadedModeId);
    const loadedMode = GAME_MODES.find((m) => m.id === loadedModeId) ?? GAME_MODES[0];
    setGameModeCategoryId(loadedMode.categoryId ?? GAME_CATEGORIES[0].id);
    const baseSettings = data.gameSettings ?? { ...DEFAULT_GAME_SETTINGS };
    const rawScore = baseSettings.scoreLimit;
    const validScore = typeof rawScore === "number" && rawScore >= 1 && rawScore <= 99 ? rawScore : (loadedMode.defaultScoreLimit ?? 21);
    const validTime = TIME_OPTIONS_30MIN.includes(baseSettings.time) ? baseSettings.time : TIME_OPTIONS_30MIN[0];
    setGameSettings({ ...baseSettings, scoreLimit: validScore, time: validTime });
    const inputs: Record<string, { s1: string; s2: string }> = {};
    for (const m of data.matches) {
      inputs[m.id] = { s1: m.score1 != null ? String(m.score1) : "", s2: m.score2 != null ? String(m.score2) : "" };
    }
    setScoreInputs(inputs);
    const matchIdSet = new Set(data.matches.map((m) => String(m.id)));
    const validPlayingIds = (data.playingMatchIds ?? []).filter((id) => matchIdSet.has(id));
    setSelectedPlayingMatchIds(validPlayingIds);
    setHighlightMemberId(null);
    setMounted(true);
  }, [effectiveGameId]);

  /** shareId가 있는 경기 열람 시 Firestore 실시간 구독 → 원격 변경 시 로컬 저장 후 state 반영 */
  useEffect(() => {
    if (effectiveGameId == null || typeof window === "undefined") return;
    const data = loadGame(effectiveGameId);
    const shareId = data.shareId;
    if (!shareId) return;
    let unsub: (() => void) | null = null;
    ensureFirebase().then(() => {
      if (!isSyncAvailable()) return;
      unsub = subscribeSharedGame(shareId, (remote) => {
      skipNextFirestorePush.current = true;
      saveGame(effectiveGameId, remote);
      const membersWithCorrectStats = recomputeMemberStatsFromMatches(remote.members, remote.matches);
      setMembers(membersWithCorrectStats);
      setGameName(typeof remote.gameName === "string" && remote.gameName.trim() ? remote.gameName.trim() : "");
      setMatches(remote.matches);
      setMyProfileMemberId(
        remote.myProfileMemberId ?? remote.members.find((m) => m.name === "송대일")?.id ?? null
      );
      const loadedModeId = remote.gameMode && GAME_MODES.some((m) => m.id === remote.gameMode) ? remote.gameMode! : GAME_MODES[0].id;
      setGameModeId(loadedModeId);
      const loadedMode = GAME_MODES.find((m) => m.id === loadedModeId) ?? GAME_MODES[0];
      setGameModeCategoryId(loadedMode.categoryId ?? GAME_CATEGORIES[0].id);
      const baseSettings = remote.gameSettings ?? { ...DEFAULT_GAME_SETTINGS };
      const rawScore = baseSettings.scoreLimit;
      const validScore = typeof rawScore === "number" && rawScore >= 1 && rawScore <= 99 ? rawScore : (loadedMode.defaultScoreLimit ?? 21);
      const validTime = TIME_OPTIONS_30MIN.includes(baseSettings.time) ? baseSettings.time : TIME_OPTIONS_30MIN[0];
      setGameSettings({ ...baseSettings, scoreLimit: validScore, time: validTime });
      const currentInputs = scoreInputsRef.current;
      const inputs: Record<string, { s1: string; s2: string }> = {};
      for (const m of remote.matches) {
        const fromRemote = { s1: m.score1 != null ? String(m.score1) : "", s2: m.score2 != null ? String(m.score2) : "" };
        const local = currentInputs[m.id];
        if (local && (local.s1 !== fromRemote.s1 || local.s2 !== fromRemote.s2)) {
          inputs[m.id] = local;
        } else {
          inputs[m.id] = fromRemote;
        }
      }
      setScoreInputs(inputs);
      const matchIdSet = new Set(remote.matches.map((m) => String(m.id)));
      const validPlayingIds = (remote.playingMatchIds ?? []).filter((id) => matchIdSet.has(id));
      setSelectedPlayingMatchIds(validPlayingIds);
    });
    });
    return () => {
      unsub?.();
    };
  }, [effectiveGameId]);

  /** 공유 링크(?share=...) 로 들어온 경우: 동기화 문서 있으면 Firestore에서 로드, 없으면 base64 디코드. 동일 shareId 중복 추가 방지 */
  useEffect(() => {
    if (typeof window === "undefined") return;
    const share = searchParams.get("share");
    if (!share) return;
    const existingIds = loadGameList();
    const alreadyImportedId = existingIds.find(
      (id) => loadGame(id).shareId === share || loadGame(id).importedFromShare === share
    );
    if (alreadyImportedId != null) {
      setNavView("record");
      setSelectedGameId(null);
      router.replace("/?view=record");
      return;
    }
    // Firestore 동기화: 먼저 getSharedGame 시도(내부에서 ensureFirebase 호출). 없으면 구형 base64 링크 시도
    getSharedGame(share).then((data) => {
      if (data) {
        const newId = createGameId();
        saveGame(newId, {
          ...data,
          playingMatchIds: data.playingMatchIds ?? [],
          shareId: share,
        });
        addGameToList(newId);
        setNavView("record");
        setSelectedGameId(null);
        router.replace("/?view=record");
        return;
      }
      const fallback = decodeGameFromShare(share);
      if (!fallback) return;
      let merged = fallback;
      if (!merged.createdByName && merged.createdBy) {
        const name = merged.members.find((m) => m.id === merged!.createdBy)?.name;
        if (name) merged = { ...merged, createdByName: name };
      }
      const newId = createGameId();
      saveGame(newId, {
        ...merged,
        createdAt: merged.createdAt ?? new Date().toISOString(),
        createdBy: merged.createdBy ?? null,
        createdByName: merged.createdByName ?? null,
        playingMatchIds: [],
        importedFromShare: share,
      });
      addGameToList(newId);
      setNavView("record");
      setSelectedGameId(null);
      router.replace("/?view=record");
    }).catch(() => {
      const data = decodeGameFromShare(share);
      if (!data) return;
      if (!data.createdByName && data.createdBy) {
        const name = data.members.find((m) => m.id === data.createdBy)?.name;
        if (name) Object.assign(data, { createdByName: name });
      }
      const newId = createGameId();
      saveGame(newId, {
        ...data,
        createdAt: data.createdAt ?? new Date().toISOString(),
        createdBy: data.createdBy ?? null,
        createdByName: data.createdByName ?? null,
        playingMatchIds: [],
        importedFromShare: share,
      });
      addGameToList(newId);
      setNavView("record");
      setSelectedGameId(null);
      router.replace("/?view=record");
    });
  }, [searchParams, router, gameId]);

  /** 경기 목록 탭에서 공유(shareId) 경기 카드를 Firestore 최신 데이터로 갱신 → 카드가 항상 최신으로 동기화 표시. 진입 시 1회 + 25초마다 갱신 */
  useEffect(() => {
    if (navView !== "record" || selectedGameId != null || typeof window === "undefined") return;
    const refresh = () => {
      const gameIds = loadGameList();
      const shared = gameIds
        .map((id) => ({ id, shareId: loadGame(id).shareId }))
        .filter((x): x is { id: string; shareId: string } => typeof x.shareId === "string" && x.shareId.length > 0);
      if (shared.length === 0) return;
      let done = 0;
      shared.forEach(({ id, shareId }) => {
        getSharedGame(shareId).then((data) => {
          if (data) saveGame(id, { ...data, shareId });
          done += 1;
          if (done === shared.length) setListRefreshKey((k) => k + 1);
        }).catch(() => {
          done += 1;
          if (done === shared.length) setListRefreshKey((k) => k + 1);
        });
      });
    };
    refresh();
    const interval = setInterval(refresh, 25000);
    return () => clearInterval(interval);
  }, [navView, selectedGameId]);

  /** 루트(/)에서 view=record 로 들어온 경우(공유 링크 등): 경기 목록 탭 표시 후 URL 정리 */
  useEffect(() => {
    if (typeof window === "undefined" || gameId != null) return;
    if (searchParams.get("view") !== "record") return;
    setNavView("record");
    setSelectedGameId(null);
    router.replace("/", { scroll: false });
  }, [gameId, searchParams, router]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    let info = loadMyInfo();
    let loggedInWithKakao = false;
    try {
      const pending = sessionStorage.getItem("kakao_profile_pending");
      if (pending) {
        const parsed = JSON.parse(pending) as { nickname?: string; email?: string; profileImageUrl?: string };
        const profileImageUrl = (parsed.profileImageUrl ?? "").trim() || undefined;
        info = {
          ...info,
          email: (parsed.email ?? "").trim() || info.email,
          profileImageUrl: profileImageUrl ?? info.profileImageUrl,
        };
        saveMyInfo(info);
        sessionStorage.removeItem("kakao_profile_pending");
        loggedInWithKakao = true;
      }
    } catch {
      // ignore
    }
    setMyInfo(info);
    if (loggedInWithKakao) {
      setKakaoLoginStatus("카카오로 로그인되었습니다.");
      try {
        if (typeof window !== "undefined" && sessionStorage.getItem("kakao_return_to_myinfo")) {
          setNavView("myinfo");
          sessionStorage.removeItem("kakao_return_to_myinfo");
        }
      } catch {
        // ignore
      }
    }
  }, []);

  useEffect(() => {
    if (!mounted || effectiveGameId === null) return;
    const existing = loadGame(effectiveGameId);
    const membersToSave =
      myProfileMemberId != null
        ? members.map((m) =>
            m.id === myProfileMemberId
              ? { ...m, name: myInfo.name, gender: myInfo.gender, grade: myInfo.grade }
              : m
          )
        : members;
    const payload: GameData = {
      members: membersToSave,
      matches,
      gameName: gameName && gameName.trim() ? gameName.trim() : undefined,
      gameMode: gameModeId,
      gameSettings,
      myProfileMemberId: myProfileMemberId ?? undefined,
      createdAt: existing.createdAt ?? undefined,
      createdBy: existing.createdBy ?? undefined,
      createdByName: existing.createdByName ?? undefined,
      playingMatchIds: selectedPlayingMatchIds,
      importedFromShare: existing.importedFromShare ?? undefined,
      shareId: existing.shareId ?? undefined,
    };
    const runSave = (id: string, data: GameData) => {
      saveGame(id, data);
      if (data.shareId && isSyncAvailable() && !skipNextFirestorePush.current) {
        const wouldOverwriteWithEmpty =
          data.members.length === 0 &&
          data.matches.length === 0 &&
          (existing.members.length > 0 || existing.matches.length > 0);
        if (!wouldOverwriteWithEmpty) {
          if (firestorePushTimeoutRef.current) clearTimeout(firestorePushTimeoutRef.current);
          firestorePushTimeoutRef.current = setTimeout(() => {
            firestorePushTimeoutRef.current = null;
            const latest = loadGame(id);
            if (latest.shareId) {
              setSharedGame(latest.shareId, latest)
                .then((ok) => { if (ok) setLastFirestoreUploadBytes(getFirestorePayloadSize(latest)); })
                .catch(() => {});
            }
          }, 1000);
        }
      }
      skipNextFirestorePush.current = false;
    };
    saveDebounceRef.current = { id: effectiveGameId, payload };
    if (saveDebounceTimerRef.current) clearTimeout(saveDebounceTimerRef.current);
    saveDebounceTimerRef.current = setTimeout(() => {
      saveDebounceTimerRef.current = null;
      const pending = saveDebounceRef.current;
      if (pending) {
        runSave(pending.id, pending.payload);
        saveDebounceRef.current = null;
      }
    }, SAVE_DEBOUNCE_MS);
    return () => {
      if (saveDebounceTimerRef.current) {
        clearTimeout(saveDebounceTimerRef.current);
        saveDebounceTimerRef.current = null;
      }
      const pending = saveDebounceRef.current;
      if (pending && pending.id === effectiveGameId) {
        runSave(pending.id, pending.payload);
        saveDebounceRef.current = null;
      }
      if (firestorePushTimeoutRef.current) {
        clearTimeout(firestorePushTimeoutRef.current);
        firestorePushTimeoutRef.current = null;
      }
    };
  }, [effectiveGameId, members, matches, gameName, gameModeId, gameSettings, myProfileMemberId, selectedPlayingMatchIds, myInfo.name, myInfo.gender, myInfo.grade, mounted]);

  useEffect(() => {
    if (!mounted) return;
    saveMyInfo(myInfo);
  }, [myInfo, mounted]);

  const addGameToRecord = useCallback(() => {
    const id = createGameId();
    const mode = GAME_MODES.find((m) => m.id === gameModeId) ?? GAME_MODES[0];
    const defaultScore = mode.defaultScoreLimit ?? 21;
    const creatorName = myProfileMemberId ? members.find((m) => m.id === myProfileMemberId)?.name : null;
    saveGame(id, {
      members: [],
      matches: [],
      gameName: undefined,
      gameMode: gameModeId,
      gameSettings: { ...DEFAULT_GAME_SETTINGS, scoreLimit: defaultScore },
      createdAt: new Date().toISOString(),
      createdBy: myProfileMemberId ?? null,
      createdByName: (creatorName ?? myInfo.name) || "-",
    });
    addGameToList(id);
    setSelectedGameId(null);
    setNavView("record");
  }, [gameModeId, myProfileMemberId, members, myInfo.name]);

  const handleShareGame = useCallback(() => {
    if (effectiveGameId === null) return;
    const id = createGameId();
    const existing = loadGame(effectiveGameId);
    saveGame(id, {
      members,
      matches,
      gameName: gameName && gameName.trim() ? gameName.trim() : undefined,
      gameMode: gameModeId,
      gameSettings,
      myProfileMemberId: myProfileMemberId ?? undefined,
      createdAt: existing.createdAt ?? undefined,
      createdBy: existing.createdBy ?? undefined,
      createdByName: existing.createdByName ?? undefined,
    });
    router.push(`/game/${id}`);
  }, [effectiveGameId, members, matches, gameName, gameModeId, gameSettings, myProfileMemberId, router]);

  /** 목록 카드에서 해당 경기 삭제. 삭제 후 경기 목록 섹션에 머물고 상세로 이동하지 않음 */
  const handleDeleteCard = useCallback((gameId: string) => {
    removeGameFromList(gameId);
    setSelectedGameId(null);
    setListMenuOpenId(null);
  }, []);

  /** 목록 카드에서 해당 경기 복사: 경기 명단 단계까지만 복사, 경기 현황은 제외 → 복사 후 명단 재편집·경기 생성 가능 */
  const handleCopyCard = useCallback((gameId: string) => {
    const existing = loadGame(gameId);
    const newId = createGameId();
    saveGame(newId, {
      members: existing.members ?? [],
      matches: [],
      gameName: existing.gameName ?? undefined,
      gameMode: existing.gameMode,
      gameSettings: existing.gameSettings ?? { ...DEFAULT_GAME_SETTINGS },
      myProfileMemberId: existing.myProfileMemberId ?? undefined,
      createdAt: new Date().toISOString(),
      createdBy: null,
      createdByName: myInfo.name || "-",
      playingMatchIds: [],
    });
    addGameToList(newId);
    setListMenuOpenId(null);
    setSelectedGameId(null);
  }, [myInfo.name]);

  /** 경기 목록 카드에서 공유: ensureFirebase()·getDb() 호출 후 Firestore sharedGames에 addDoc(신규) 또는 setDoc(기존), shareId 링크 복사 */
  const handleShareCard = useCallback(async (targetGameId: string) => {
    const data = loadGame(targetGameId);
    await ensureFirebase();
    const db = getDb();
    let shareParam: string;
    let firebaseFailed = false;
    if (db) {
      if (data.shareId) {
        const payload = { ...data, shareId: data.shareId };
        const ok = await setSharedGame(data.shareId, payload);
        shareParam = ok ? data.shareId : encodeGameForShare(data);
        if (ok) {
          saveGame(targetGameId, payload);
          setLastFirestoreUploadBytes(getFirestorePayloadSize(payload));
        } else firebaseFailed = true;
      } else {
        const newId = await addSharedGame(data);
        if (newId) {
          const toSave = { ...data, shareId: newId };
          saveGame(targetGameId, toSave);
          shareParam = newId;
          setLastFirestoreUploadBytes(getFirestorePayloadSize(toSave));
        } else {
          shareParam = encodeGameForShare(data);
          firebaseFailed = true;
        }
      }
    } else {
      shareParam = encodeGameForShare(data);
      firebaseFailed = true;
    }
    const url = `${typeof window !== "undefined" ? window.location.origin : ""}/?share=${shareParam}`;
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(url).then(
        () => {
          setShareToast(
            firebaseFailed
              ? "공유 링크는 복사되었습니다. Firebase 업로드는 실패했습니다. 브라우저 콘솔(F12)을 확인하세요."
              : "공유 링크가 복사되었습니다. 참가자에게 전달해 명단 신청·경기 결과 입력에 사용하세요."
          );
          setListMenuOpenId(null);
          setTimeout(() => setShareToast(null), 4500);
        },
        () => {
          setShareToast("복사에 실패했습니다.");
          setTimeout(() => setShareToast(null), 2500);
        }
      );
    } else {
      setShareToast(
        firebaseFailed
          ? "공유 링크는 복사되었습니다. Firebase 업로드는 실패했습니다. 브라우저 콘솔(F12)을 확인하세요."
          : "공유 링크가 복사되었습니다. 참가자에게 전달해 명단 신청·경기 결과 입력에 사용하세요."
      );
      setListMenuOpenId(null);
      setTimeout(() => setShareToast(null), 4500);
    }
  }, []);

  /** 경기 방식에서 선정한 로직으로만 경기 생성. 인원 수 검사 후 generateMatchesByGameMode 단일 진입점 사용. */
  const doMatch = useCallback(() => {
    const mode = GAME_MODES.find((m) => m.id === gameModeId);
    if (!mode || members.length < mode.minPlayers || members.length > mode.maxPlayers) return;
    const shuffled = [...members].sort(() => Math.random() - 0.5);
    const newMatches = generateMatchesByGameMode(gameModeId, shuffled);
    if (newMatches.length === 0) return;
    const inputs: Record<string, { s1: string; s2: string }> = {};
    for (const m of newMatches) {
      inputs[m.id] = { s1: "", s2: "" };
    }
    setMatches(newMatches);
    setScoreInputs(inputs);
    setSelectedPlayingMatchIds([]);
    setMembers((prev) =>
      prev.map((m) => ({ ...m, wins: 0, losses: 0, pointDiff: 0 }))
    );
  }, [members, gameModeId]);

  const scoreLimit = Math.max(1, gameSettings.scoreLimit || 21);

  const saveResult = useCallback(
    (matchId: string) => {
      const input = scoreInputs[matchId];
      if (!input) return;
      const s1 = input.s1.trim() === "" ? 0 : parseInt(input.s1, 10);
      const s2 = input.s2.trim() === "" ? 0 : parseInt(input.s2, 10);
      if (Number.isNaN(s1) || Number.isNaN(s2) || s1 < 0 || s2 < 0) return;
      if (s1 > scoreLimit || s2 > scoreLimit) return;
      const match = matches.find((m) => m.id === matchId);
      if (!match) return;

      const winnerFirst = s1 > s2;
      const diff = Math.abs(s1 - s2);
      const now = new Date().toISOString();
      const savedByName = myInfo.name?.trim() || null;
      const record = { at: now, by: myProfileMemberId ?? "", savedByName };

      const nextMatches = matches.map((m) =>
        m.id === matchId
          ? {
              ...m,
              score1: s1,
              score2: s2,
              savedAt: now,
              savedBy: myProfileMemberId ?? null,
              savedHistory: [...(m.savedHistory ?? []), record],
            }
          : m
      );
      setMatches(nextMatches);
      setMembers((prev) => recomputeMemberStatsFromMatches(prev, nextMatches));
      setSelectedPlayingMatchIds((prev) => prev.filter((id) => id !== matchId));
      setScoreInputs((prev) => ({ ...prev, [matchId]: { s1: String(s1), s2: String(s2) } }));
    },
    [matches, scoreInputs, scoreLimit, myProfileMemberId, myInfo.name]
  );

  const updateScoreInput = useCallback((matchId: string, side: "s1" | "s2", value: string) => {
    setScoreInputs((prev) => ({
      ...prev,
      [matchId]: { ...prev[matchId], [side]: value },
    }));
  }, []);

  const addMember = useCallback((name: string, gender: "M" | "F", grade: Grade) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setMembers((prev) => {
      const max = GAME_MODES.find((m) => m.id === gameModeId)?.maxPlayers ?? 12;
      if (prev.length >= max) return prev;
      return [
      ...prev,
      {
        id: createId(),
        name: trimmed,
        gender,
        grade,
        wins: 0,
        losses: 0,
        pointDiff: 0,
      },
    ];
    });
  }, [gameModeId]);

  const removeMember = useCallback((id: string) => {
    setMembers((prev) => prev.filter((m) => m.id !== id));
  }, []);

  const ranking = [...members].sort((a, b) => {
    if (b.wins !== a.wins) return b.wins - a.wins;
    if (b.pointDiff !== a.pointDiff) return b.pointDiff - a.pointDiff;
    return GRADE_ORDER[a.grade] - GRADE_ORDER[b.grade];
  });

  /** 매치에서 4명의 선수 id 추출 (공통 로직) */
  const getMatchPlayerIds = (match: Match): string[] => {
    const p1 = match.team1?.players?.[0]?.id;
    const p2 = match.team1?.players?.[1]?.id;
    const p3 = match.team2?.players?.[0]?.id;
    const p4 = match.team2?.players?.[1]?.id;
    return [p1, p2, p3, p4].filter((x): x is string => x != null && x !== "").map((x) => String(x));
  };

  /** 진행중으로 선택된 매치들 (id 문자열로 통일). 종료된 경기는 진행에서 제외 → 실제 코트에서 겨루는 경기만 */
  const playingMatchIdsSet = new Set(selectedPlayingMatchIds.map((id) => String(id)));
  const playingMatches = matches.filter(
    (m) => playingMatchIdsSet.has(String(m.id)) && m.score1 == null && m.score2 == null
  );

  /** 진행 표식된 경기에만 참가한 선수 id = 지금 코트에서 경기 중인 인원. 나머지 = 쉬는 인원. */
  const playingIds = new Set<string>();
  for (const pm of playingMatches) {
    for (const id of getMatchPlayerIds(pm)) {
      playingIds.add(String(id));
    }
  }
  /** 쉬는 인원 id 집합 (진행 외 전원 = 종료한 사람 포함 모두 쉬는 중) */
  const restingIds = new Set(members.map((m) => String(m.id)).filter((id) => !playingIds.has(id)));
  const waitingMembers = members.filter((m) => !playingIds.has(String(m.id)));

  /** 이 경기 4명이 전원 '쉬는 인원'이면 true → 가능(바로 시작 가능). 진행 중인 사람이 1명이라도 있으면 대기. */
  const matchPlayersAllWaiting = (match: Match): boolean => {
    const ids = getMatchPlayerIds(match);
    if (ids.length !== 4) return false;
    return ids.every((id) => restingIds.has(String(id)));
  };

  /**
   * 가능 = 바로 시작할 수 있는 경기.
   * - 진행 중인 경기가 하나도 없으면 → 종료 이외의 모든 경기를 가능으로 표시.
   * - 진행 중인 경기가 있으면 → 4명 모두 진행 외 인원인 경기만 가능.
   * (현재 매치 목록에 없는 id는 무시 → 저장 후 등 항상 '진행 없음'이면 전부 가능)
   */
  const hasPlayingInList = selectedPlayingMatchIds.some((id) =>
    matches.some((m) => String(m.id) === String(id))
  );
  const noPlayingSelected = !hasPlayingInList;
  const playableMatches = matches.filter((m) => {
    const isFinished = m.score1 != null && m.score2 != null;
    if (isFinished) return false;
    if (playingMatchIdsSet.has(String(m.id))) return false;
    if (noPlayingSelected) return true; // 진행 없음 → 종료 이외 전부 가능
    return matchPlayersAllWaiting(m);
  });
  const canStartNext = playableMatches.length > 0;
  /** 가능한 경기 id 집합 (표식 반영용, id 문자열 통일) */
  const playableMatchIdsSet = new Set(playableMatches.map((m) => String(m.id)));

  /**
   * 진행 토글: 한 사람은 한 경기에만 진행으로 있을 수 있음 (중복 불가).
   * 새로 진행에 넣을 때, 이미 진행인 경기 중 이 경기와 선수가 겹치면 해당 경기는 진행에서 제거.
   */
  const togglePlayingMatch = (matchId: string) => {
    const match = matches.find((m) => m.id === matchId);
    if (!match) return;
    const thisPlayerIds = new Set(getMatchPlayerIds(match));

    setSelectedPlayingMatchIds((prev) => {
      if (prev.includes(matchId)) {
        return prev.filter((id) => id !== matchId);
      }
      // 추가 시: 이 경기와 선수가 겹치는 진행 경기는 모두 제거 후 이 경기만 추가
      const noOverlap = prev.filter((id) => {
        const other = matches.find((m) => m.id === id);
        if (!other) return false;
        const otherIds = getMatchPlayerIds(other);
        const overlap = otherIds.some((pid) => thisPlayerIds.has(pid));
        return !overlap;
      });
      return [...noOverlap, matchId];
    });
  };

  const scrollTo = (id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth" });
  };

  if (!mounted) {
    return (
      <div className="min-h-screen bg-[#f5f5f7] flex items-center justify-center">
        <div className="text-[#6e6e73] text-sm font-medium">로딩 중...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#f5f5f7] text-[#1d1d1f] max-w-md mx-auto flex flex-col">
      {/* 헤더 - Apple 스타일: 블러, 미니멀 */}
      <header className="sticky top-0 z-20 bg-white/80 backdrop-blur-xl border-b border-[#e8e8ed] safe-area-pb">
        <div className="flex items-center gap-3 px-3 py-4">
          <span className="text-2xl flex items-center shrink-0" aria-hidden>
            {navView === "setting" && <img src="/game-mode-icon.png?v=2" alt="" className="w-12 h-12 object-contain" />}
            {navView === "record" && <img src="/game-list-icon.png" alt="" className="w-12 h-12 object-contain" />}
            {navView === "myinfo" && <img src="/myinfo-icon.png" alt="" className="w-12 h-12 object-contain" />}
          </span>
          <h1 className="text-[1.25rem] font-semibold tracking-tight text-[#1d1d1f] flex items-center gap-1.5">
            {navView === "setting" && (
              <>
                경기 방식
                <button
                  type="button"
                  onClick={() => setShowGameModeHelp(true)}
                  className="w-6 h-6 flex items-center justify-center rounded-full bg-slate-200 text-slate-600 hover:bg-slate-300 text-xs font-medium transition-colors"
                  aria-label="도움말"
                >
                  ?
                </button>
              </>
            )}
            {navView === "record" && (
              <>
                경기 목록
                <button
                  type="button"
                  onClick={() => setShowRecordHelp(true)}
                  className="w-6 h-6 flex items-center justify-center rounded-full bg-slate-200 text-slate-600 hover:bg-slate-300 text-xs font-medium transition-colors"
                  aria-label="도움말"
                >
                  ?
                </button>
              </>
            )}
            {navView === "myinfo" && "경기 이사"}
          </h1>
        </div>
      </header>

      {/* 경기 방식 도움말 팝업 */}
      {showGameModeHelp && (
        <>
          <div className="fixed inset-0 z-30 bg-black/20" aria-hidden onClick={() => setShowGameModeHelp(false)} />
          <div className="fixed left-1/2 top-1/2 z-40 w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-2xl bg-white p-4 shadow-xl border border-[#e8e8ed]">
            <p className="text-sm text-slate-700 leading-relaxed">
              각 카테고리 내에 여러 개의 경기 방식을 업데이트 중에 있습니다. 설명을 읽고 원하는 경기 방식을 선택하여 경기 목록으로 이동시킬 수 있습니다.
            </p>
            <button
              type="button"
              onClick={() => setShowGameModeHelp(false)}
              className="mt-3 w-full py-2 rounded-xl text-sm font-medium bg-slate-100 text-slate-700 hover:bg-slate-200 transition-colors"
            >
              닫기
            </button>
          </div>
        </>
      )}

      {/* 경기 목록 도움말 팝업 */}
      {showRecordHelp && (
        <>
          <div className="fixed inset-0 z-30 bg-black/20" aria-hidden onClick={() => setShowRecordHelp(false)} />
          <div className="fixed left-1/2 top-1/2 z-40 w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-2xl bg-white p-4 shadow-xl border border-[#e8e8ed]">
            <p className="text-sm text-slate-700 leading-relaxed">
              선택한 경기 방식이 경기 목록에 추가됩니다. 원하는 경기를 누르면 상세가 열려 편집할 수 있습니다. 공유 링크를 참가자에게 전달하면, 받은 사람은 경기 명단에 신청(참가자 추가)하고 경기 현황에서 경기 결과를 함께 입력할 수 있습니다.
            </p>
            <button
              type="button"
              onClick={() => setShowRecordHelp(false)}
              className="mt-3 w-full py-2 rounded-xl text-sm font-medium bg-slate-100 text-slate-700 hover:bg-slate-200 transition-colors"
            >
              닫기
            </button>
          </div>
        </>
      )}

      <main className="flex-1 px-2 pb-24 overflow-auto">
        {navView === "setting" && (
        <div key="setting" className="space-y-2 pt-4 animate-fade-in">
        {/* 경기 방식: 카테고리 탭 + 좌측 목록 + 우측 상세 (참고 이미지 구조) */}
        <section id="section-info" className="scroll-mt-2">
          <div className="rounded-2xl bg-white shadow-[0_1px_3px_rgba(0,0,0,0.06)] border border-[#e8e8ed] overflow-hidden min-w-0">
            {/* 상단 카테고리 탭 - 줄바꿈 방지 */}
            <div className="flex border-b border-[#e8e8ed] overflow-x-auto flex-nowrap">
              {GAME_CATEGORIES.map((cat) => {
                const modesInCat = GAME_MODES.filter((m) => (m.categoryId ?? GAME_CATEGORIES[0].id) === cat.id);
                const isActive = gameModeCategoryId === cat.id;
                return (
                  <button
                    key={cat.id}
                    type="button"
                    onClick={() => {
                      setGameModeCategoryId(cat.id);
                      const firstInCat = modesInCat[0];
                      if (firstInCat && !modesInCat.some((m) => m.id === gameModeId)) {
                        setGameModeId(firstInCat.id);
                        const defaultScore = firstInCat.defaultScoreLimit ?? 21;
                        setGameSettings((prev) => ({ ...prev, scoreLimit: prev.scoreLimit >= 1 && prev.scoreLimit <= 99 ? prev.scoreLimit : defaultScore }));
                      }
                    }}
                    className={`shrink-0 px-3 py-2.5 text-sm font-medium border-b-2 transition-colors ${isActive ? "border-[#0071e3] text-[#0071e3]" : "border-transparent text-slate-600 hover:text-slate-800"}`}
                  >
                    {cat.label}
                  </button>
                );
              })}
            </div>
            <div className="flex flex-row min-h-0 min-w-[280px]">
              {/* 좌측: 해당 카테고리 경기 방식 목록 */}
              <nav className="min-w-[3.75rem] w-[3.75rem] shrink-0 border-r border-[#e8e8ed] bg-slate-50/50">
                <ul className="py-0">
                  {GAME_MODES.filter((m) => (m.categoryId ?? GAME_CATEGORIES[0].id) === gameModeCategoryId).map((mode) => {
                    const isSelected = gameModeId === mode.id;
                    return (
                      <li key={mode.id}>
                        <button
                          type="button"
                          onClick={() => {
                            setGameModeId(mode.id);
                            const defaultScore = mode.defaultScoreLimit ?? 21;
                            setGameSettings((prev) => ({ ...prev, scoreLimit: prev.scoreLimit >= 1 && prev.scoreLimit <= 99 ? prev.scoreLimit : defaultScore }));
                          }}
                          className={`w-full text-left px-0 py-0 min-h-[1.5rem] text-sm rounded-r border-l-2 transition-colors whitespace-nowrap ${isSelected ? "border-[#0071e3] bg-[#0071e3]/10 text-[#0071e3] font-medium" : "border-transparent text-slate-700 hover:bg-slate-100/80"}`}
                        >
                          {mode.label}
                        </button>
                      </li>
                    );
                  })}
                </ul>
                {GAME_MODES.filter((m) => (m.categoryId ?? GAME_CATEGORIES[0].id) === gameModeCategoryId).length === 0 && (
                  <p className="px-0.5 py-2 text-xs text-slate-500">이 카테고리에 등록된 경기 방식이 없습니다.</p>
                )}
              </nav>
              {/* 우측: 해당 카테고리에서 선택한 경기 방식일 때만 상세 표시 */}
              <div className="flex-1 min-w-0 px-1 py-1 text-fluid-base text-[#6e6e73] space-y-1 leading-relaxed">
                {(gameMode.categoryId ?? GAME_CATEGORIES[0].id) === gameModeCategoryId ? (
                  <>
                    <button
                      type="button"
                      onClick={addGameToRecord}
                      disabled={gameModeId === "individual_b"}
                      className="w-full py-1.5 rounded-xl font-semibold text-white bg-[#0071e3] hover:bg-[#0077ed] transition-colors mb-3 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-[#0071e3] btn-tap"
                    >
                      아래 경기 방식으로 경기 목록에 추가
                    </button>
                    {gameModeId === "individual_b" && (
                      <p className="text-xs text-slate-500 mb-2">개인전b는 아직 경기 목록 추가 기능을 지원하지 않습니다.</p>
                    )}
                    {gameModeId === "individual" ? (
                      <div className="space-y-3">
                        <div>
                          <p className="text-sm font-semibold text-[#0071e3] mb-0.5 leading-tight">특징</p>
                          <div className="space-y-0.5 text-slate-600 text-sm leading-tight">
                            <p>인원에 따라 총 경기 수와 인당 경기 수가 아래 표처럼 정해져 있으며, 참가자는 모두 동일한 경기 수로 공정하게 진행합니다.</p>
                            <p>파트너와 상대를 경기마다 바꿔 가며 여러 분과 골고루 대전할 수 있습니다.</p>
                          </div>
                        </div>
                        <div>
                          <p className="text-sm font-semibold text-[#0071e3] mb-0.5 leading-tight">인원</p>
                          <p className="text-slate-600 text-sm leading-tight">{gameMode.minPlayers}~{gameMode.maxPlayers}명</p>
                        </div>
                        <div>
                          <p className="text-sm font-semibold text-[#0071e3] mb-0.5 leading-tight">경기수·소요시간</p>
                          <div className="overflow-x-auto mt-0.5 min-w-0">
                            <table className="w-full min-w-[240px] table-fixed border-collapse text-xs text-slate-600 leading-tight font-numeric">
                              <colgroup>
                                <col style={{ width: "20%" }} />
                                <col style={{ width: "20%" }} />
                                <col style={{ width: "20%" }} />
                                <col style={{ width: "20%" }} />
                                <col style={{ width: "20%" }} />
                              </colgroup>
                              <thead>
                                <tr className="bg-slate-100">
                                  <th className="border border-slate-200 px-2 py-0 text-center font-semibold text-slate-700 whitespace-nowrap">인원</th>
                                  <th className="border border-slate-200 px-2 py-0 text-center font-semibold text-slate-700 whitespace-nowrap">총</th>
                                  <th className="border border-slate-200 px-2 py-0 text-center font-semibold text-slate-700 whitespace-nowrap">인당</th>
                                  <th className="border border-slate-200 px-2 py-0 text-center font-semibold text-slate-700 whitespace-nowrap">코트</th>
                                  <th className="border border-slate-200 px-2 py-0 text-center font-semibold text-slate-700 whitespace-nowrap">소요</th>
                                </tr>
                              </thead>
                              <tbody>
                                {Array.from({ length: gameMode.maxPlayers - gameMode.minPlayers + 1 }, (_, i) => gameMode.minPlayers + i).map((n) => {
                                  const total = getTargetTotalGames(n);
                                  const perPerson = total > 0 && n > 0 ? Math.round((total * 4) / n) : 0;
                                  const maxCourts = getMaxCourts(n);
                                  const totalMinutesRaw = total * MINUTES_PER_21PT_GAME;
                                  const minutesForMaxCourts = Math.ceil(totalMinutesRaw / maxCourts);
                                  const durationLabel = formatEstimatedDuration(minutesForMaxCourts);
                                  const courtLabel = maxCourts;
                                  return (
                                    <tr key={n} className="even:bg-slate-50">
                                      <td className="border border-slate-200 px-2 py-0 text-center whitespace-nowrap">{n}</td>
                                      <td className="border border-slate-200 px-2 py-0 text-center whitespace-nowrap">{total}</td>
                                      <td className="border border-slate-200 px-2 py-0 text-center whitespace-nowrap">{perPerson}</td>
                                      <td className="border border-slate-200 px-2 py-0 text-center text-slate-600 whitespace-nowrap">{courtLabel}</td>
                                      <td className="border border-slate-200 px-2 py-0 text-center text-slate-600 whitespace-nowrap">{durationLabel}</td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          </div>
                        </div>
                      </div>
                    ) : gameModeId === "individual_b" ? (
                      <div className="space-y-3">
                        <div>
                          <p className="text-sm font-semibold text-[#0071e3] mb-0.5 leading-tight">특징</p>
                          <p className="text-slate-600 text-sm leading-tight">개인전b 전용 규칙입니다. (내용 추후 입력)</p>
                        </div>
                        <div>
                          <p className="text-sm font-semibold text-[#0071e3] mb-0.5 leading-tight">인원</p>
                          <p className="text-slate-500 text-sm leading-tight">추후 정의됩니다.</p>
                        </div>
                        <div>
                          <p className="text-sm font-semibold text-[#0071e3] mb-0.5 leading-tight">경기수·소요시간</p>
                          <p className="text-slate-500 text-xs leading-tight">개인전b 전용 표는 추후 정의됩니다.</p>
                        </div>
                      </div>
                    ) : (
                      <div className="space-y-3">
                        <div>
                          <p className="text-sm font-semibold text-[#0071e3] mb-0.5 leading-tight">인원</p>
                          <p className="text-slate-600 text-sm leading-tight">{gameMode.minPlayers}~{gameMode.maxPlayers}명</p>
                        </div>
                      </div>
                    )}
                  </>
                ) : (
                  <p className="text-sm text-slate-500 py-8 text-center">왼쪽 목록에서 경기 방식을 선택하면 상세 내용이 표시됩니다.</p>
                )}
              </div>
            </div>
          </div>
        </section>
        </div>
        )}

        {navView === "record" && !selectedGameId && (
        /* 경기 목록: Firestore 동기화된 카드는 listRefreshKey 갱신 시 최신 데이터 표시 */
        <div key={`record-list-${listRefreshKey}`} className="pt-4 space-y-0.5 animate-fade-in">
          {(() => {
            const gameIds = loadGameList();
            const sortedIds = [...gameIds].sort((a, b) => {
              const tA = loadGame(a).createdAt ?? "";
              const tB = loadGame(b).createdAt ?? "";
              return tB.localeCompare(tA);
            });
            return gameIds.length === 0 ? (
              <p className="text-sm text-slate-500 py-8 text-center">아직 추가된 경기이 없습니다.<br />경기 세팅에서 경기 방식을 선택한 뒤 &#39;목록에 추가&#39;를 누르세요.</p>
            ) : (
            <ul className="space-y-0.5">
              {sortedIds.map((id, index) => {
                const data = loadGame(id);
                const isNewest = index === 0;
                const mode = data.gameMode ? GAME_MODES.find((m) => m.id === data.gameMode) : null;
                const modeLabel = mode?.label ?? data.gameMode ?? "경기";
                const hasCustomName = typeof data.gameName === "string" && data.gameName.trim();
                const titleLabel = hasCustomName ? data.gameName!.trim().replace(/_/g, " ") : "";
                const dateStr = data.createdAt ? (() => {
                  try {
                    const d = new Date(data.createdAt!);
                    return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
                  } catch {
                    return "";
                  }
                })() : "";
                const creatorName = data.createdBy ? data.members.find((m) => m.id === data.createdBy)?.name : null;
                const creatorDisplay = creatorName ?? data.createdByName ?? "알 수 없음";
                const hasMatches = data.matches.length > 0;
                const completedCount = data.matches.filter((m) => m.score1 != null && m.score2 != null).length;
                const matchIdSet = new Set(data.matches.map((m) => String(m.id)));
                const ongoingCount = (data.playingMatchIds ?? []).filter((id) => matchIdSet.has(id)).length;
                const allDone = hasMatches && completedCount === data.matches.length;
                /** 신청: 경기 0개. 생성: 경기 있음 & 종료 0 & 진행 0. 진행: 종료 또는 진행 1개 이상(전부 종료 전). 종료: 전부 종료 */
                const currentStage =
                  !hasMatches
                    ? "신청단계"
                    : completedCount === 0 && ongoingCount === 0
                      ? "생성단계"
                      : allDone
                        ? "종료단계"
                        : "진행단계";
                const stages = ["신청단계", "생성단계", "진행단계", "종료단계"] as const;
                /** 단계별 뱃지 하이라이트 */
                const stageHighlight: Record<(typeof stages)[number], string> = {
                  신청단계: "bg-green-100 text-green-700 border border-green-200",
                  생성단계: "bg-blue-100 text-blue-700 border border-blue-200",
                  진행단계: "bg-amber-100 text-amber-700 border border-amber-200",
                  종료단계: "bg-slate-800 text-white border border-slate-700",
                };
                /** 테이블 헤더도 현재 단계와 동일 색채로 매칭 */
                const tableHeaderByStage: Record<(typeof stages)[number], string> = {
                  신청단계: "bg-green-100 text-green-700",
                  생성단계: "bg-blue-100 text-blue-700",
                  진행단계: "bg-amber-100 text-amber-700",
                  종료단계: "bg-slate-800 text-white",
                };
                const stageMuted = "bg-slate-50 text-slate-400";
                const tableHeaderClass = tableHeaderByStage[currentStage];
                const total = data.matches.length;
                const waitingCount = total - completedCount - ongoingCount;
                const pct = (n: number) => (total ? Math.round((n / total) * 100) : 0);
                const isMenuOpen = listMenuOpenId === id;
                return (
                  <li key={id} className={`relative ${isNewest ? "animate-slide-up" : ""}`}>
                    {isNewest && (
                      <span className="absolute left-0 top-0 z-10" style={{ width: 18, height: 18 }}>
                        <span className="absolute left-0 top-0 block" style={{ width: 0, height: 0, borderStyle: "solid", borderWidth: "18px 18px 0 0", borderColor: "#f59e0b transparent transparent transparent" }} />
                        <span className="absolute left-[4px] top-[3px] text-[9px] font-bold text-white leading-none drop-shadow-[0_0_1px_rgba(0,0,0,0.5)]">
                          N
                        </span>
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={() => { setListMenuOpenId(null); setSelectedGameId(id); }}
                      className="w-full text-left px-2.5 py-1.5 pr-8 rounded-lg bg-white border border-[#e8e8ed] shadow-[0_1px_2px_rgba(0,0,0,0.05)] hover:bg-slate-50 transition-colors btn-tap"
                    >
                      {/* 1행: 경기 이름 (공간 확보, 비어 있으면 빈 줄 유지) */}
                      <p className="font-semibold text-slate-800 truncate text-sm leading-tight font-numeric min-h-[1.25rem]" title={titleLabel}>{titleLabel || "\u00A0"}</p>
                      {/* 경기 요약 축약: 방식·인원·언제·어디·승점 + 만든이, 그 하단에 뱃지·테이블 */}
                      <div className="mt-0 space-y-px w-full block">
                        <p className="text-fluid-sm text-slate-500 leading-tight">경기 방식: {modeLabel}</p>
                          <p className="text-fluid-sm text-slate-500 leading-tight font-numeric">
                            경기 인원: 현재 {data.members.length}명 기준
                            {mode && data.members.length >= mode.minPlayers && data.members.length <= mode.maxPlayers ? (
                              (() => {
                                const targetTotal = getTargetTotalGames(data.members.length);
                                const perPerson = targetTotal > 0 ? Math.round((targetTotal * 4) / data.members.length) : "-";
                                return <> 총 {targetTotal}경기 · 인당 {perPerson}경기</>;
                              })()
                            ) : (
                              <> 총 -경기 · 인당 -경기</>
                            )}
                          </p>
                          {(() => {
                            const gs = data.gameSettings;
                            const date = gs?.date?.trim();
                            const time = gs?.time?.trim();
                            const loc = gs?.location?.trim();
                            const score = typeof gs?.scoreLimit === "number" && gs.scoreLimit >= 1 ? gs.scoreLimit : null;
                            const parts: string[] = [];
                            if (date) {
                              try {
                                const [y, m, d] = date.split("-");
                                if (m && d) parts.push(`${parseInt(m, 10)}/${parseInt(d, 10)}`);
                              } catch {
                                parts.push(date);
                              }
                            }
                            if (time) parts.push(time);
                            if (loc) parts.push(loc.length > 8 ? `${loc.slice(0, 8)}…` : loc);
                            if (score) parts.push(`${score}점제`);
                            if (parts.length > 0) {
                              return (
                                <p className="text-fluid-sm text-slate-500 leading-tight">
                                  경기 언제·어디·승점: {parts.join(" · ")}
                                </p>
                              );
                            }
                            return null;
                          })()}
                          <p className="text-fluid-sm text-slate-500 leading-tight">
                            만든 이: {creatorDisplay}{dateStr ? ` ${dateStr}` : ""}
                          </p>
                        {/* 신청·생성·진행·종료 뱃지 + 총/종료/진행/대기 테이블 (경기 요약 하단, 전체 너비) */}
                        <div className="w-full flex flex-col gap-0.5 pt-1">
                          <div className="flex items-center gap-1 flex-wrap">
                            {stages.map((s) => (
                              <span
                                key={s}
                                className={`text-xs font-medium px-1.5 py-0 rounded-full shrink-0 leading-none ${s === currentStage ? stageHighlight[s] : stageMuted}`}
                              >
                                {s.replace("단계", "")}
                              </span>
                            ))}
                          </div>
                          {total > 0 && (
                            <table className="w-full max-w-[200px] text-xs border border-slate-200 rounded overflow-hidden font-numeric table-fixed border-collapse">
                              <tbody>
                                <tr className={tableHeaderClass}>
                                  <th className={`py-0 px-1 text-center font-medium leading-none w-1/4 border-r ${currentStage === "종료단계" ? "border-slate-600" : "border-slate-200"}`}>총</th>
                                  <th className={`py-0 px-1 text-center font-medium leading-none w-1/4 border-r ${currentStage === "종료단계" ? "border-slate-600" : "border-slate-200"}`}>종료</th>
                                  <th className={`py-0 px-1 text-center font-medium leading-none w-1/4 border-r ${currentStage === "종료단계" ? "border-slate-600" : "border-slate-200"}`}>진행</th>
                                  <th className="py-0 px-1 text-center font-medium leading-none w-1/4">대기</th>
                                </tr>
                                <tr className="border-t border-[#e8e8ed] bg-white text-slate-700">
                                  <td className="py-0 px-1 text-center font-medium leading-none border-r border-slate-200">{total}</td>
                                  <td className="py-0 px-1 text-center font-medium border-r border-slate-200 leading-none">{completedCount}</td>
                                  <td className="py-0 px-1 text-center font-medium border-r border-slate-200 leading-none">{ongoingCount}</td>
                                  <td className="py-0 px-1 text-center font-medium leading-none">{waitingCount}</td>
                                </tr>
                                <tr className="bg-white text-slate-700">
                                  <td className="py-0 px-1 text-center text-slate-500 font-normal leading-none border-r border-slate-200">{pct(total)}%</td>
                                  <td className="py-0 px-1 text-center text-slate-500 font-normal border-r border-slate-200 leading-none">{pct(completedCount)}%</td>
                                  <td className="py-0 px-1 text-center text-slate-500 font-normal border-r border-slate-200 leading-none">{pct(ongoingCount)}%</td>
                                  <td className="py-0 px-1 text-center text-slate-500 font-normal leading-none">{pct(waitingCount)}%</td>
                                </tr>
                              </tbody>
                            </table>
                          )}
                        </div>
                      </div>
                    </button>
                    {/* 카드별 ... 메뉴 (삭제·복사) */}
                    <div className="absolute top-1 right-1">
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); setListMenuOpenId((prev) => (prev === id ? null : id)); }}
                        className="p-1 rounded text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                        aria-label="메뉴"
                        aria-expanded={isMenuOpen}
                      >
                        <span className="text-base leading-none">⋯</span>
                      </button>
                      {isMenuOpen && (
                        <>
                          <div className="fixed inset-0 z-10" aria-hidden onClick={() => setListMenuOpenId(null)} />
                          <div className="absolute right-0 top-full mt-0.5 py-1 min-w-[100px] rounded-lg bg-white border border-slate-200 shadow-lg z-20">
                            <button
                              type="button"
                              onClick={(e) => { e.stopPropagation(); handleDeleteCard(id); }}
                              className="w-full text-left px-2.5 py-1.5 text-xs text-red-600 hover:bg-red-50 rounded-t-lg btn-tap"
                            >
                              삭제
                            </button>
                            <button
                              type="button"
                              onClick={(e) => { e.stopPropagation(); handleCopyCard(id); }}
                              className="w-full text-left px-2.5 py-1.5 text-xs text-slate-700 hover:bg-slate-50 btn-tap"
                            >
                              복사
                            </button>
                            <button
                              type="button"
                              onClick={(e) => { e.stopPropagation(); handleShareCard(id); }}
                              className="w-full text-left px-2.5 py-1.5 text-xs text-slate-700 hover:bg-slate-50 rounded-b-lg btn-tap"
                            >
                              공유
                            </button>
                          </div>
                        </>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
            );
          })()}
        </div>
        )}

        {navView === "record" && selectedGameId && (
        <div key="record-detail" className="animate-fade-in">
        <div className="space-y-4 pt-4">
        {/* 선택한 경기: 경기 요약·명단·대진·현황·랭킹 */}
          <div className="flex items-center justify-between gap-2 pb-2">
            <button
              type="button"
              onClick={() => setSelectedGameId(null)}
              className="text-sm font-medium text-[#0071e3] hover:underline"
            >
              ← 목록으로
            </button>
            {lastFirestoreUploadBytes != null && loadGame(effectiveGameId ?? null).shareId && (
              <span className="text-xs text-slate-500 font-numeric" title="방금 Firestore에 업로드한 용량">
                마지막 업로드: {lastFirestoreUploadBytes < 1024 ? `${lastFirestoreUploadBytes} B` : `${(lastFirestoreUploadBytes / 1024).toFixed(2)} KB`}
              </span>
            )}
          </div>
          {/* 경기 요약 카드 */}
          <div className="rounded-2xl bg-white shadow-[0_1px_3px_rgba(0,0,0,0.06)] border border-[#e8e8ed] overflow-hidden mt-2">
            <div className="px-4 py-0.5 border-b border-[#e8e8ed]">
              <h3 className="text-base font-semibold text-slate-800 leading-tight">경기 요약</h3>
            </div>
            <div className="px-4 py-0.5 space-y-px">
              <div className="flex items-center gap-0.5 py-0.5">
                <label htmlFor="game-name" className="text-xs font-medium text-slate-600 shrink-0 w-16">경기 이름</label>
                <input
                  id="game-name"
                  type="text"
                  value={gameName}
                  onChange={(e) => setGameName(e.target.value)}
                  placeholder="경기 이름 입력"
                  className="flex-1 min-w-0 px-2 py-0.5 rounded-lg border border-[#d2d2d7] bg-[#fbfbfd] text-[#1d1d1f] placeholder:text-[#6e6e73] text-sm focus:outline-none focus:ring-2 focus:ring-[#0071e3]/25 focus:border-[#0071e3]"
                  aria-label="경기 이름"
                />
              </div>
              <div className="flex items-center gap-0.5 py-0.5">
                <span className="text-xs font-medium text-slate-600 shrink-0 w-16">경기 방식</span>
                <span className="flex-1 text-sm font-medium text-slate-500 bg-slate-100 px-2 py-0.5 rounded-lg border border-slate-200 cursor-default select-none" title="경기 방식에서 선택한 값 (변경 불가)">
                  {gameMode.label}
                </span>
              </div>
              <div className="flex items-center gap-0.5 py-0.5">
                <span className="text-xs font-medium text-slate-600 shrink-0 w-16">경기 인원</span>
                <span className="flex-1 text-sm font-medium text-slate-500 font-numeric bg-slate-100 px-2 py-0.5 rounded-lg border border-slate-200 cursor-default select-none inline-block" title="경기 명단 인원 기준 (변경 불가)">
                  현재 {members.length}명 기준
                  {members.length >= gameMode.minPlayers && members.length <= gameMode.maxPlayers ? (
                    <> 총 {getTargetTotalGames(members.length)}경기 · 인당 {getTargetTotalGames(members.length) > 0 ? Math.round((getTargetTotalGames(members.length) * 4) / members.length) : "-"}경기</>
                  ) : (
                    <> 총 -경기 · 인당 -경기</>
                  )}
                </span>
              </div>
              <div className="flex items-center gap-0.5 py-0.5">
                <label htmlFor="game-date" className="text-xs font-medium text-slate-600 shrink-0 w-16">경기 언제</label>
                <input
                  id="game-date"
                  type="date"
                  value={gameSettings.date}
                  onChange={(e) => setGameSettings((s) => ({ ...s, date: e.target.value }))}
                  className="flex-1 min-w-0 px-2 py-0.5 rounded-lg border border-[#d2d2d7] bg-[#fbfbfd] text-[#1d1d1f] text-sm focus:outline-none focus:ring-2 focus:ring-[#0071e3]/25 focus:border-[#0071e3] focus:border-blue-400"
                  aria-label="날짜"
                />
                <select
                  value={TIME_OPTIONS_30MIN.includes(gameSettings.time) ? gameSettings.time : TIME_OPTIONS_30MIN[0]}
                  onChange={(e) => setGameSettings((s) => ({ ...s, time: e.target.value }))}
                  className="w-24 px-2 py-0.5 rounded-lg border border-[#d2d2d7] bg-[#fbfbfd] text-[#1d1d1f] text-sm focus:outline-none focus:ring-2 focus:ring-[#0071e3]/25 focus:border-[#0071e3] focus:border-blue-400"
                  aria-label="시작 시간 (30분 단위)"
                >
                  {TIME_OPTIONS_30MIN.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex items-center gap-0.5 py-0.5">
                <label htmlFor="game-location" className="text-xs font-medium text-slate-600 shrink-0 w-16">경기 어디</label>
                <input
                  id="game-location"
                  type="text"
                  value={gameSettings.location}
                  onChange={(e) => setGameSettings((s) => ({ ...s, location: e.target.value }))}
                  placeholder="장소 입력"
                  className="flex-1 min-w-0 px-2 py-0.5 rounded-lg border border-[#d2d2d7] bg-[#fbfbfd] text-[#1d1d1f] placeholder:text-[#6e6e73] text-sm focus:outline-none focus:ring-2 focus:ring-[#0071e3]/25 focus:border-[#0071e3]"
                  aria-label="장소"
                />
              </div>
              <div className="flex items-center gap-0.5 py-0.5">
                <label htmlFor="game-score-limit" className="text-xs font-medium text-slate-600 shrink-0 w-16">경기 승점</label>
                <input
                  id="game-score-limit"
                  type="number"
                  min={1}
                  max={99}
                  value={gameSettings.scoreLimit}
                  onChange={(e) => {
                    if (e.target.value === "") {
                      setGameSettings((s) => ({ ...s, scoreLimit: 21 }));
                      return;
                    }
                    const v = parseInt(e.target.value, 10);
                    const num = Number.isNaN(v) ? 21 : Math.max(1, Math.min(99, v));
                    setGameSettings((s) => ({ ...s, scoreLimit: num }));
                  }}
                  placeholder="21"
                  className="flex-1 min-w-0 w-20 px-2 py-0.5 rounded-lg border border-[#d2d2d7] bg-[#fbfbfd] text-[#1d1d1f] text-sm focus:outline-none focus:ring-2 focus:ring-[#0071e3]/25 focus:border-[#0071e3] focus:border-blue-400 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                  aria-label="한 경기당 득점 제한 (직접 입력)"
                />
                <span className="text-xs text-slate-500 shrink-0">점</span>
              </div>
            </div>
          </div>

          {/* 경기 명단 카드 - 报名名单 스타일 */}
          <div id="section-members" className="rounded-2xl bg-white shadow-[0_1px_3px_rgba(0,0,0,0.06)] border border-[#e8e8ed] overflow-hidden mt-2 scroll-mt-2">
            <div className="px-2 py-1.5 border-b border-[#e8e8ed] flex items-center justify-between">
              <div>
                <h3 className="text-base font-semibold text-slate-800">경기 명단</h3>
                <p className="text-xs text-slate-500 mt-0.5">아래에서 경기 인원을 추가·삭제할 수 있습니다</p>
              </div>
              <span className="shrink-0 px-1.5 py-0.5 rounded-full text-xs font-medium bg-slate-100 text-slate-600 border border-slate-200">
                {members.length}명
              </span>
            </div>
            <div className="w-full overflow-x-auto">
              <table className="w-full border-collapse border border-slate-300 text-left">
                <thead>
                  <tr className="bg-slate-100">
                    <th className="border-l border-slate-300 first:border-l-0 px-1 py-0.5 text-xs font-semibold text-slate-700 w-10">번호</th>
                    <th className="border-l border-slate-300 px-1 py-0.5 text-xs font-semibold text-slate-700 min-w-[6rem] w-32">이름</th>
                    <th className="border-l border-slate-300 px-1 py-0.5 text-xs font-semibold text-slate-700 w-9">성별</th>
                    <th className="border-l border-slate-300 px-1 py-0.5 text-xs font-semibold text-slate-700 w-12">급수</th>
                    <th className="border-l border-slate-300 px-1 py-0.5 text-xs font-semibold text-slate-700 min-w-[3rem] w-14">삭제</th>
                  </tr>
                </thead>
                <tbody>
                  {members.map((m, i) => (
                    <tr key={m.id} className="bg-slate-50 even:bg-white">
                      <td className="border-l border-slate-300 first:border-l-0 px-1 py-0.5">
                        {String(i + 1).padStart(2, "0")}
                      </td>
                      <td className="border-l border-slate-300 px-1 py-0.5 text-sm font-semibold text-slate-800 whitespace-nowrap min-w-0">
                        {m.name}
                      </td>
                      <td className="border-l border-slate-300 px-1 py-0.5 text-xs text-slate-500">
                        {m.gender === "M" ? "남" : m.gender === "F" ? "여" : "-"}
                      </td>
                      <td className="border-l border-slate-300 px-1 py-0.5 text-xs text-slate-600">
                        {m.grade}
                      </td>
                      <td className="border-l border-slate-300 px-1 py-0.5">
                        <button
                          type="button"
                          onClick={() => removeMember(m.id)}
                          className="w-6 h-6 flex items-center justify-center text-xs text-slate-500 hover:bg-red-100 hover:text-red-600"
                          aria-label={`${m.name} 제거`}
                        >
                          ×
                        </button>
                      </td>
                    </tr>
                  ))}
                  <tr className="bg-slate-100/50">
                    <td className="border-l border-slate-300 first:border-l-0 px-1 py-0.5 align-middle text-slate-500 text-xs">+</td>
                    <td className="border-l border-slate-300 px-1 py-0.5 align-middle min-w-0">
                      <input
                        type="text"
                        value={newMemberName}
                        onChange={(e) => setNewMemberName(e.target.value)}
                        placeholder="이름"
                        aria-label="이름"
                        className="w-full min-w-0 h-6 px-1.5 py-0 text-xs rounded border border-[#d2d2d7] bg-[#fbfbfd] text-[#1d1d1f] placeholder:text-[#6e6e73] focus:outline-none focus:ring-1 focus:ring-[#0071e3]/25 focus:border-[#0071e3] box-border"
                      />
                    </td>
                    <td className="border-l border-slate-300 px-1 py-0.5 align-middle">
                      <select
                        value={newMemberGender}
                        onChange={(e) => setNewMemberGender(e.target.value as "M" | "F")}
                        aria-label="성별"
                        className="w-full min-w-0 h-6 px-0.5 py-0 text-xs rounded border border-[#d2d2d7] bg-[#fbfbfd] text-[#1d1d1f] focus:outline-none focus:ring-1 focus:ring-[#0071e3]/25 focus:border-[#0071e3]"
                      >
                        <option value="M">남</option>
                        <option value="F">여</option>
                      </select>
                    </td>
                    <td className="border-l border-slate-300 px-1 py-0.5 align-middle">
                      <select
                        value={newMemberGrade}
                        onChange={(e) => setNewMemberGrade(e.target.value as Grade)}
                        aria-label="급수"
                        className="w-full min-w-0 h-6 px-0.5 py-0 text-xs rounded border border-[#d2d2d7] bg-[#fbfbfd] text-[#1d1d1f] focus:outline-none focus:ring-1 focus:ring-[#0071e3]/25 focus:border-[#0071e3]"
                      >
                        <option value="A">A</option>
                        <option value="B">B</option>
                        <option value="C">C</option>
                        <option value="D">D</option>
                      </select>
                    </td>
                    <td className="border-l border-slate-300 px-1 py-0.5 align-middle w-14 min-w-[3rem]">
                      <button
                        type="button"
                        onClick={() => {
                          const trimmed = newMemberName.trim();
                          if (!trimmed) {
                            alert("이름을 입력해 주세요.");
                            return;
                          }
                          if (members.length >= gameMode.maxPlayers) {
                            alert(`경기 인원은 최대 ${gameMode.maxPlayers}명까지입니다.`);
                            return;
                          }
                          addMember(trimmed, newMemberGender, newMemberGrade);
                          setNewMemberName("");
                        }}
                        className="h-6 min-w-[2.25rem] px-2 rounded text-xs font-medium text-white whitespace-nowrap hover:opacity-90 bg-[#0071e3] box-border"
                      >
                        추가
                      </button>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div className="border-t border-[#e8e8ed] px-2 py-2">
              <p className="text-xs text-slate-500 mb-1">
                현재 <span className="font-numeric">{members.length}</span>명 기준 총 <strong className="text-slate-700 font-numeric">{members.length >= gameMode.minPlayers ? getTargetTotalGames(members.length) : "-"}</strong>경기 인당 <strong className="text-slate-700 font-numeric">{members.length >= gameMode.minPlayers && getTargetTotalGames(members.length) > 0 ? Math.round((getTargetTotalGames(members.length) * 4) / members.length) : "-"}</strong>경기
              </p>
              <button
                type="button"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  if (members.length < gameMode.minPlayers || members.length > gameMode.maxPlayers) {
                    alert(`경기 인원은 ${gameMode.minPlayers}~${gameMode.maxPlayers}명이어야 합니다.`);
                    return;
                  }
                  if (matches.length > 0) {
                    setShowRegenerateConfirm(true);
                    return;
                  }
                  doMatch();
                }}
                className="w-full py-3 rounded-xl font-semibold text-white transition-colors hover:opacity-95 bg-[#0071e3] hover:bg-[#0077ed] btn-tap"
              >
                경기 생성
              </button>
              {members.length < gameMode.minPlayers && (
                <p className="text-xs text-slate-400 mt-1 text-center">경기 인원은 <span className="font-numeric">{gameMode.minPlayers}</span>~<span className="font-numeric">{gameMode.maxPlayers}</span>명이어야 합니다.</p>
              )}
              {members.length > gameMode.maxPlayers && (
                <p className="text-xs text-slate-400 mt-1 text-center">경기 인원은 <span className="font-numeric">{gameMode.maxPlayers}</span>명까지입니다.</p>
              )}
            </div>
          </div>

          {/* 매치 목록 - 1줄씩 */}
          <section id="section-matches" className="scroll-mt-2">
          {matches.length > 0 && (
            <div className="rounded-2xl bg-white shadow-[0_1px_3px_rgba(0,0,0,0.06)] border border-[#e8e8ed] overflow-hidden mt-2">
              <div className="px-2 py-1.5 border-b border-[#e8e8ed]">
                <h3 className="text-base font-semibold text-slate-800">경기 현황</h3>
                {(() => {
                  const ids = new Set<string>();
                  matches.forEach((m) => {
                    ids.add(m.team1.players[0].id);
                    ids.add(m.team1.players[1].id);
                    ids.add(m.team2.players[0].id);
                    ids.add(m.team2.players[1].id);
                  });
                  const memberCount = ids.size;
                  const perPerson =
                    memberCount > 0 ? Math.round((matches.length * 4) / memberCount) : 0;
                  return (
                    <p className="text-xs text-slate-500 mt-0.5">
                      현재 <span className="font-numeric">{memberCount}</span>명 기준 · 총 <span className="font-numeric">{matches.length}</span>경기 · 인당 <span className="font-medium text-slate-700 font-numeric">{perPerson}</span>경기 (동일)
                    </p>
                  );
                })()}
              </div>
              <div className="px-2 py-1 border-b border-[#e8e8ed]">
                {/* 총 / 종료 / 진행 / 대기 테이블 */}
                {(() => {
                  const total = matches.length;
                  const completedCount = matches.filter((m) => m.score1 != null && m.score2 != null).length;
                  const ongoingCount = playingMatches.length;
                  const waitingCount = total - completedCount - ongoingCount;
                  const pct = (n: number) => (total ? Math.round((n / total) * 100) : 0);
                  return (
                    <table className="w-full text-sm border border-slate-200 rounded overflow-hidden font-numeric table-fixed border-collapse">
                      <tbody className="bg-white text-slate-700">
                        <tr className="bg-slate-100 text-slate-600">
                          <th className="py-0.5 px-1 text-center font-medium w-1/4 border-r border-slate-200">총</th>
                          <th className="py-0.5 px-1 text-center font-medium w-1/4 border-r border-slate-200">종료</th>
                          <th className="py-0.5 px-1 text-center font-medium w-1/4 border-r border-slate-200">진행</th>
                          <th className="py-0.5 px-1 text-center font-medium w-1/4">대기</th>
                        </tr>
                        <tr className="border-t border-slate-200">
                          <td className="py-0.5 px-1 text-center font-medium border-r border-slate-200">{total}</td>
                          <td className="py-0.5 px-1 text-center font-medium border-r border-slate-200">{completedCount}</td>
                          <td className="py-0.5 px-1 text-center font-medium border-r border-slate-200">{ongoingCount}</td>
                          <td className="py-0.5 px-1 text-center font-medium">{waitingCount}</td>
                        </tr>
                        <tr className="border-t border-slate-200">
                          <td className="py-0.5 px-1 text-center text-slate-500 font-normal border-r border-slate-200">{pct(total)}%</td>
                          <td className="py-0.5 px-1 text-center text-slate-500 font-normal border-r border-slate-200">{pct(completedCount)}%</td>
                          <td className="py-0.5 px-1 text-center text-slate-500 font-normal border-r border-slate-200">{pct(ongoingCount)}%</td>
                          <td className="py-0.5 px-1 text-center text-slate-500 font-normal">{pct(waitingCount)}%</td>
                        </tr>
                      </tbody>
                    </table>
                  );
                })()}
                {playingMatches.length > 0 && (
                  <p className="text-fluid-xs text-slate-400 mt-1">
                    진행 뱃지 다시 눌러 해제 · 가능 <span className="font-numeric">{playableMatches.length}</span>경기
                  </p>
                )}
              </div>
              <div className="divide-y divide-slate-100">
                {matches.map((m, index) => {
                  const isCurrent = playingMatchIdsSet.has(String(m.id));
                  const isDone = m.score1 !== null && m.score2 !== null;
                  /** 가능 = playableMatchIdsSet과 동일 기준 (진행 표식 외 인원만으로 된 경기 = 가능) */
                  const isPlayable =
                    !isDone &&
                    !isCurrent &&
                    playableMatchIdsSet.has(String(m.id));
                  /** 표식: 종료 → 진행 → 가능(바로 시작 가능) → 대기 */
                  const statusLabel = isDone ? "종료" : isCurrent ? "진행" : isPlayable ? "가능" : "대기";
                  const statusColor = isDone
                    ? "bg-slate-200 text-slate-600"
                    : isCurrent
                      ? "bg-amber-100 text-amber-700 border border-amber-200"
                      : isPlayable
                        ? "bg-green-500 text-white border border-green-600 font-semibold"
                        : "bg-slate-100 text-slate-600";
                  const canSelect = !isDone;
                  const history = m.savedHistory && m.savedHistory.length > 0 ? m.savedHistory : (m.savedAt ? [{ at: m.savedAt, by: m.savedBy ?? "", savedByName: null }] : []);
                  const lastSaved = history.length > 0 ? history[history.length - 1] : null;
                  const savedByName = lastSaved?.savedByName ?? (lastSaved?.by ? members.find((p) => p.id === lastSaved.by)?.name : null);
                  const savedAtStr = lastSaved ? formatSavedAt(lastSaved.at) : "";
                  const statusLine = isDone && (m.score1 ?? 0) === 0 && (m.score2 ?? 0) === 0
                    ? "승패 미반영"
                    : isDone && (m.score1 ?? 0) === (m.score2 ?? 0)
                      ? "승패 미반영 (동점)"
                      : isDone
                        ? `승패 반영 (${(m.score1 ?? 0) > (m.score2 ?? 0) ? "왼쪽 승" : "오른쪽 승"})`
                        : null;
                  const hasInfoLine = (savedByName != null || savedAtStr) || statusLine != null;
                  return (
                  <div
                    key={m.id}
                    className={`flex flex-col gap-0.5 px-0.5 py-0.5 ${isCurrent ? "bg-amber-50/50" : isPlayable ? "bg-green-50/90 ring-1 ring-green-300/60 rounded-r-lg" : "bg-white hover:bg-slate-50/80"}`}
                  >
                    <div className={`flex flex-nowrap items-center gap-x-1 text-sm overflow-x-auto ${isCurrent ? "hover:bg-amber-50/70" : ""}`}>
                    <span className="shrink-0 text-sm font-semibold text-slate-600 min-w-[1.25rem]">
                      {String(index + 1).padStart(2, "0")}
                    </span>
                    <button
                      type="button"
                      onClick={() => canSelect && togglePlayingMatch(m.id)}
                      title={canSelect ? (isCurrent ? "진행 해제" : "진행으로 선택") : undefined}
                      className={`shrink-0 min-w-[2rem] px-1 py-0.5 rounded text-xs font-medium flex flex-row items-center justify-center gap-0 leading-none ${statusColor} ${canSelect ? "cursor-pointer hover:opacity-80" : "cursor-default"}`}
                    >
                      {statusLabel}
                    </button>
                    <div className="min-w-0 flex-1 flex flex-col justify-center text-left max-w-[5.5rem] gap-0 overflow-hidden">
                      {m.team1.players.map((p) => {
                        const isHighlight = p.id === highlightMemberId;
                        return (
                          <button
                            key={p.id}
                            type="button"
                            onClick={() => setHighlightMemberId((prev) => (prev === p.id ? null : p.id))}
                            className={`block w-full text-left text-sm leading-none truncate rounded px-0.5 -mx-0.5 ${isHighlight ? "bg-amber-400 text-amber-900 font-bold ring-1 ring-amber-500" : "font-medium text-slate-700 hover:bg-slate-100"} ${highlightMemberId && !isHighlight ? "opacity-90" : ""}`}
                            title={isHighlight ? "클릭 시 하이라이트 해제" : `${p.name} 클릭 시 이 선수 경기만 하이라이트 (같은 줄 왼쪽=파트너, 오른쪽=상대)`}
                          >
                            {p.name} <span className={isHighlight ? "text-amber-900/80 font-semibold" : "text-slate-500 font-normal"}>({p.gender === "M" ? "남" : "여"} {p.grade})</span>
                          </button>
                        );
                      })}
                    </div>
                    <div className="shrink-0 w-12 flex items-center justify-center">
                      <div className="flex items-center gap-0">
                        <input
                          type="number"
                          min={0}
                          max={scoreLimit}
                          placeholder="0"
                          value={scoreInputs[m.id]?.s1 ?? (m.score1 != null ? String(m.score1) : "")}
                          onChange={(e) => {
                            let v = e.target.value;
                            const n = parseInt(v, 10);
                            if (v !== "" && !Number.isNaN(n) && n > scoreLimit) v = String(scoreLimit);
                            updateScoreInput(m.id, "s1", v);
                          }}
                          className="w-9 h-7 rounded border border-slate-200 bg-slate-50 text-slate-800 text-center text-sm font-medium font-numeric focus:outline-none focus:ring-1 focus:ring-blue-200 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                          aria-label="팀1 득점"
                          title={`0~${scoreLimit}점 (경기 설정 기준)`}
                        />
                        <span className="text-slate-400 text-sm font-medium">:</span>
                        <input
                          type="number"
                          min={0}
                          max={scoreLimit}
                          placeholder="0"
                          value={scoreInputs[m.id]?.s2 ?? (m.score2 != null ? String(m.score2) : "")}
                          onChange={(e) => {
                            let v = e.target.value;
                            const n = parseInt(v, 10);
                            if (v !== "" && !Number.isNaN(n) && n > scoreLimit) v = String(scoreLimit);
                            updateScoreInput(m.id, "s2", v);
                          }}
                          className="w-9 h-7 rounded border border-slate-200 bg-slate-50 text-slate-800 text-center text-sm font-medium font-numeric focus:outline-none focus:ring-1 focus:ring-blue-200 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                          aria-label="팀2 득점"
                          title={`0~${scoreLimit}점 (경기 설정 기준)`}
                        />
                      </div>
                    </div>
                    <div className="min-w-0 flex-1 flex flex-col justify-center text-right max-w-[5.5rem] gap-0 overflow-hidden">
                      {m.team2.players.map((p) => {
                        const isHighlight = p.id === highlightMemberId;
                        return (
                          <button
                            key={p.id}
                            type="button"
                            onClick={() => setHighlightMemberId((prev) => (prev === p.id ? null : p.id))}
                            className={`block w-full text-right text-sm leading-none truncate rounded px-0.5 -mx-0.5 ${isHighlight ? "bg-amber-400 text-amber-900 font-bold ring-1 ring-amber-500" : "font-medium text-slate-700 hover:bg-slate-100"} ${highlightMemberId && !isHighlight ? "opacity-90" : ""}`}
                            title={isHighlight ? "클릭 시 하이라이트 해제" : `${p.name} 클릭 시 이 선수 경기만 하이라이트 (같은 줄 왼쪽=파트너, 오른쪽=상대)`}
                          >
                            {p.name} <span className={isHighlight ? "text-amber-900/80 font-semibold" : "text-slate-500 font-normal"}>({p.gender === "M" ? "남" : "여"} {p.grade})</span>
                          </button>
                        );
                      })}
                    </div>
                    <button
                      type="button"
                      onClick={() => saveResult(m.id)}
                      className="shrink-0 min-w-[2rem] px-1 py-1 rounded text-xs font-semibold leading-none text-white bg-[#0071e3] hover:bg-[#0077ed] transition-colors flex flex-row items-center justify-center"
                    >
                      저장
                    </button>
                    </div>
                    {hasInfoLine && (
                      <p className="text-fluid-xs text-slate-500 pl-10 leading-tight flex items-center gap-1.5 flex-wrap" title={lastSaved ? new Date(lastSaved.at).toLocaleString("ko-KR") : ""}>
                        {(savedByName != null || savedAtStr) && (
                          <span className="font-medium text-slate-600">{savedByName ?? "—"} {savedAtStr}</span>
                        )}
                        {statusLine != null && (
                          <span className="text-amber-600 font-medium">{statusLine}</span>
                        )}
                      </p>
                    )}
                  </div>
                  );
                })}
              </div>
            </div>
          )}
        </section>

        {/* 경기 결과(랭킹) 카드 */}
        <section id="section-ranking" className="scroll-mt-2">
          <div className="rounded-2xl bg-white shadow-[0_1px_3px_rgba(0,0,0,0.06)] border border-[#e8e8ed] overflow-hidden">
            <div className="px-2 py-1.5 border-b border-[#e8e8ed]">
              <h3 className="text-base font-semibold text-slate-800">경기 결과</h3>
              <p className="text-xs text-slate-500 mt-0.5">승수가 높을수록 위로, 같으면 득실차가 좋은 순, 그다음 급수 순으로 정렬됩니다.</p>
            </div>
            <ul className="divide-y divide-slate-100">
              {ranking.map((m, i) => {
                const rank = i + 1;
                const isTop3 = rank <= 3;
                const rowBg = rank === 1 ? "bg-amber-50/80" : rank === 2 ? "bg-slate-100/80" : rank === 3 ? "bg-amber-100/50" : "hover:bg-slate-50/80";
                const medalColor = rank === 1 ? "#E5A00D" : rank === 2 ? "#94A3B8" : "#B45309";
                const medalStroke = rank === 1 ? "#C4890C" : rank === 2 ? "#64748B" : "#92400E";
                return (
                  <li key={m.id} className={`flex items-center gap-2 px-2 py-0.5 min-h-0 leading-tight ${rowBg}`}>
                    <span className="w-8 h-6 flex items-center justify-center flex-shrink-0">
                      {isTop3 ? (
                        <span className="relative inline-flex items-center justify-center" aria-label={`${rank}위`}>
                          <svg width="24" height="26" viewBox="0 0 24 26" fill="none" xmlns="http://www.w3.org/2000/svg" className="drop-shadow-md">
                            <defs>
                              <linearGradient id={`medalGrad${rank}`} x1="0%" y1="0%" x2="100%" y2="100%">
                                <stop offset="0%" stopColor={rank === 1 ? "#FFF4B8" : rank === 2 ? "#E8ECF1" : "#E8C89C"} />
                                <stop offset="35%" stopColor={medalColor} />
                                <stop offset="70%" stopColor={medalStroke} />
                                <stop offset="100%" stopColor={rank === 1 ? "#B8860B" : rank === 2 ? "#64748B" : "#783F04"} />
                              </linearGradient>
                              <linearGradient id={`medalShine${rank}`} x1="0%" y1="0%" x2="100%" y2="100%">
                                <stop offset="0%" stopColor="rgba(255,255,255,0.65)" />
                                <stop offset="50%" stopColor="rgba(255,255,255,0.15)" />
                                <stop offset="100%" stopColor="rgba(255,255,255,0)" />
                              </linearGradient>
                              <linearGradient id={`ringGrad${rank}`} x1="0%" y1="0%" x2="0%" y2="100%">
                                <stop offset="0%" stopColor={rank === 1 ? "#D4A017" : rank === 2 ? "#94A3B8" : "#A0522D"} />
                                <stop offset="100%" stopColor={medalStroke} />
                              </linearGradient>
                              <filter id={`medalShadow${rank}`} x="-20%" y="-20%" width="140%" height="140%">
                                <feDropShadow dx="0" dy="1" stdDeviation="0.8" floodColor="rgba(0,0,0,0.25)" />
                              </filter>
                            </defs>
                            <g filter={`url(#medalShadow${rank})`}>
                              {/* 목줄 고리 */}
                              <rect x="9" y="0.5" width="6" height="2.5" rx="1.25" fill={`url(#ringGrad${rank})`} stroke={medalStroke} strokeWidth="0.6" />
                              {/* 목줄 리본 */}
                              <path d="M 10.5 3 L 11.3 4.5 L 12 4.2 L 12.7 4.5 L 13.5 3 L 12 4 Z" fill={`url(#ringGrad${rank})`} stroke={medalStroke} strokeWidth="0.4" opacity={0.95} />
                              {/* 메달 원판 - 그라데이션 */}
                              <circle cx="12" cy="13" r="9" fill={`url(#medalGrad${rank})`} stroke={medalStroke} strokeWidth="1.2" />
                              {/* 메달 테두리 내부 링 */}
                              <circle cx="12" cy="13" r="7.2" fill="none" stroke="rgba(255,255,255,0.5)" strokeWidth="0.8" />
                              <circle cx="12" cy="13" r="5.8" fill="none" stroke="rgba(0,0,0,0.12)" strokeWidth="0.4" />
                              {/* 상단 하이라이트 (광택) */}
                              <ellipse cx="12" cy="10.5" rx="5" ry="3" fill={`url(#medalShine${rank})`} />
                              {/* 순위 숫자 */}
                              <text x="12" y="16" textAnchor="middle" fill="#fff" fontSize="10" fontWeight="bold" fontFamily="system-ui" stroke="rgba(0,0,0,0.2)" strokeWidth="0.6">{rank}</text>
                            </g>
                          </svg>
                        </span>
                      ) : (
                        <span className="text-xs font-medium text-slate-800">{rank}</span>
                      )}
                    </span>
                    <div className="flex-1 min-w-0 flex items-center gap-1.5 leading-tight">
                      <span className="font-medium text-slate-800 text-sm">{m.name}</span>
                      <span className="text-slate-400 text-xs">{m.gender === "M" ? "남" : m.gender === "F" ? "여" : "-"}</span>
                      <span className="text-slate-500 text-xs">{m.grade}</span>
                    </div>
                    <div className="text-right text-xs text-slate-600 leading-tight">
                      <span className="font-medium text-slate-700">{m.wins}승</span>
                      <span className="text-slate-400 mx-1">/</span>
                      <span className="text-slate-600">{m.losses}패</span>
                      <span className="text-slate-500 ml-1.5">
                        {m.pointDiff >= 0 ? "+" : ""}{m.pointDiff}
                      </span>
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        </section>

        </div>
        </div>
        )}

        {navView === "myinfo" && (
          <div key="myinfo" className="pt-4 space-y-2 animate-fade-in">
            {/* 로그인 기능 최상단 */}
            <div className="rounded-2xl bg-white shadow-[0_1px_3px_rgba(0,0,0,0.06)] border border-[#e8e8ed] overflow-hidden">
              <div className="px-3 py-3 space-y-3">
                {getKakaoJsKey() && (
                  <>
                    <button
                      type="button"
                      onClick={() => {
                        setKakaoLoginStatus("리다이렉트 중...");
                        if (typeof window !== "undefined") initKakao();
                        loginWithKakao();
                      }}
                      className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl text-sm font-medium bg-[#FEE500] text-[#191919] hover:bg-[#fdd835] transition-colors btn-tap"
                    >
                      <span className="text-lg">💬</span>
                      카카오로 시작
                    </button>
                    <div className="flex items-center gap-2">
                      <span className="flex-1 h-px bg-slate-200" />
                      <span className="text-xs text-slate-400">또는</span>
                      <span className="flex-1 h-px bg-slate-200" />
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        logoutKakao();
                        setMyInfo((prev) => ({ ...prev, profileImageUrl: undefined, email: undefined }));
                        setKakaoLoginStatus("카카오에서 로그아웃했습니다.");
                      }}
                      className="w-full px-4 py-2 rounded-lg text-sm font-medium bg-slate-100 text-slate-700 hover:bg-slate-200 transition-colors btn-tap"
                    >
                      카카오 로그아웃
                    </button>
                  </>
                )}
                {kakaoLoginStatus && (
                  <p
                    className={`text-xs px-2 py-1.5 rounded-lg ${
                      kakaoLoginStatus === "카카오로 로그인되었습니다."
                        ? "bg-amber-100 text-amber-900 font-medium border border-amber-200"
                        : "text-slate-500"
                    }`}
                  >
                    {kakaoLoginStatus}
                  </p>
                )}
                {!getKakaoJsKey() && (
                  <p className="text-xs text-amber-600">
                    로컬: .env.local에 NEXT_PUBLIC_KAKAO_JAVASCRIPT_KEY 추가 후 개발 서버 재시작. 배포(Vercel): 프로젝트 설정 → Environment Variables에 동일 키 추가 후 재배포.
                  </p>
                )}
              </div>
            </div>
            <p className="text-sm text-slate-600 leading-snug mb-1.5">로그인 정보, 가입 클럽, 승률 통계를 확인·수정할 수 있습니다.</p>
            <div className="rounded-2xl bg-white shadow-[0_1px_3px_rgba(0,0,0,0.06)] border border-[#e8e8ed] overflow-hidden">
              <div className="px-2 py-2 space-y-4">
                <div>
                  <h3 className="text-sm font-semibold text-slate-700 mb-1.5">로그인 정보</h3>
                  {(myInfo.profileImageUrl || myInfo.name) && (
                    <div className="flex items-center gap-3 mb-3 p-2 rounded-xl bg-slate-50 border border-slate-100">
                      <div className="flex-shrink-0 w-12 h-12 rounded-full overflow-hidden bg-slate-200 ring-2 ring-white shadow">
                        {myInfo.profileImageUrl ? (
                          <img
                            src={myInfo.profileImageUrl}
                            alt="프로필"
                            className="w-full h-full object-cover"
                            referrerPolicy="no-referrer"
                          />
                        ) : (
                          <span className="w-full h-full flex items-center justify-center text-slate-500 text-lg font-medium">
                            {myInfo.name?.charAt(0)?.toUpperCase() || "?"}
                          </span>
                        )}
                      </div>
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-slate-800 truncate">{myInfo.name || "이름 없음"}</p>
                        <p className="text-xs text-slate-500 truncate">{myInfo.email || "이메일 없음"}</p>
                      </div>
                    </div>
                  )}
                  <p className="text-xs text-slate-500 mb-1">앱에 연동할 이메일·이름입니다. (현재 로컬 저장)</p>
                  <p className="text-xs text-slate-500 mb-1.5">로그인 정보와 결합해 나를 정의합니다.</p>
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      type="text"
                      value={myInfo.name}
                      onChange={(e) => setMyInfo((prev) => ({ ...prev, name: e.target.value }))}
                      placeholder="이름"
                      className="flex-1 min-w-[4rem] px-2 py-1.5 rounded-xl border border-[#d2d2d7] bg-[#fbfbfd] text-[#1d1d1f] text-sm focus:outline-none focus:ring-2 focus:ring-[#0071e3]/25 focus:border-[#0071e3]"
                      aria-label="이름"
                    />
                    <select
                      value={myInfo.gender}
                      onChange={(e) => setMyInfo((prev) => ({ ...prev, gender: e.target.value as "M" | "F" }))}
                      className="px-2 py-1.5 rounded-xl border border-[#d2d2d7] bg-[#fbfbfd] text-[#1d1d1f] text-sm focus:outline-none focus:ring-2 focus:ring-[#0071e3]/25 focus:border-[#0071e3] shrink-0"
                      aria-label="성별"
                    >
                      <option value="M">남</option>
                      <option value="F">여</option>
                    </select>
                    <select
                      value={myInfo.grade}
                      onChange={(e) => setMyInfo((prev) => ({ ...prev, grade: e.target.value as Grade }))}
                      className="w-14 px-2 py-1.5 rounded-xl border border-[#d2d2d7] bg-[#fbfbfd] text-[#1d1d1f] text-sm focus:outline-none focus:ring-2 focus:ring-[#0071e3]/25 focus:border-[#0071e3] shrink-0"
                      aria-label="급수"
                    >
                      <option value="A">A</option>
                      <option value="B">B</option>
                      <option value="C">C</option>
                      <option value="D">D</option>
                    </select>
                  </div>
                </div>
                <div>
                  <h3 className="text-sm font-semibold text-slate-700 mb-1.5">승률 통계</h3>
                  <p className="text-xs text-slate-500 mb-1.5">나를 기준으로 상대 조합(AA·AB·BB 등)별 승률만 테이블로 표시합니다.</p>
                  {!myProfileMemberId ? (
                    <p className="text-slate-500 text-xs py-2">나가 지정되지 않았습니다.</p>
                  ) : (
                    <>
                      {(() => {
                        const completed = matches.filter((m) => m.score1 != null && m.score2 != null);
                        type PairStats = { wins: number; losses: number };
                        const byPair: Record<string, PairStats> = {};
                        for (const m of completed) {
                          const in1 = m.team1.players.some((p) => p.id === myProfileMemberId);
                          const in2 = m.team2.players.some((p) => p.id === myProfileMemberId);
                          if (!in1 && !in2) continue;
                          const opponentTeam = in1 ? m.team2 : m.team1;
                          const pairKey = [opponentTeam.players[0].grade, opponentTeam.players[1].grade].sort().join("");
                          if (!byPair[pairKey]) byPair[pairKey] = { wins: 0, losses: 0 };
                          const myWon = in1 ? (m.score1! > m.score2!) : (m.score2! > m.score1!);
                          if (myWon) byPair[pairKey].wins += 1;
                          else byPair[pairKey].losses += 1;
                        }
                        const pairs = Object.entries(byPair).sort(([a], [b]) => a.localeCompare(b));
                        return pairs.length === 0 ? (
                          <p className="text-slate-500 text-xs px-2 py-3">완료된 경기가 없거나 나가 참가한 경기가 없습니다.</p>
                        ) : (
                          <table className="w-full text-xs border-collapse font-numeric">
                            <thead>
                              <tr className="bg-slate-100/60 text-slate-600 font-semibold">
                                <th className="text-left py-1.5 px-2 border-b border-slate-200">상대 조합</th>
                                <th className="text-right py-1.5 px-2 border-b border-slate-200">승</th>
                                <th className="text-right py-1.5 px-2 border-b border-slate-200">패</th>
                                <th className="text-right py-1.5 px-2 border-b border-slate-200">승률</th>
                              </tr>
                            </thead>
                            <tbody className="text-slate-700">
                              {pairs.map(([pair, st]) => {
                                const total = st.wins + st.losses;
                                const pct = total > 0 ? Math.round((st.wins / total) * 100) : 0;
                                return (
                                  <tr key={pair} className="border-b border-slate-100 last:border-b-0">
                                    <td className="py-1.5 px-2 font-medium">{pair}조</td>
                                    <td className="py-1.5 px-2 text-right font-semibold text-slate-700">{st.wins}</td>
                                    <td className="py-1.5 px-2 text-right font-semibold text-slate-700">{st.losses}</td>
                                    <td className="py-1.5 px-2 text-right font-medium">{pct}%</td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        );
                      })()}
                    </>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}
      </main>

      {/* 하단 네비 - 블러·미니멀 */}
      <nav className="fixed bottom-0 left-0 right-0 max-w-md mx-auto bg-white/90 backdrop-blur-xl border-t border-[#e8e8ed] flex justify-start gap-0 px-2 py-2 shadow-[0_-1px_0_0_rgba(0,0,0,0.06)]">
        <button
          type="button"
          onClick={() => setNavView("setting")}
          className={`flex flex-col items-center gap-0.5 py-2 px-4 min-w-0 rounded-xl transition-colors btn-tap ${navView === "setting" ? "bg-[#0071e3]/10 text-[#0071e3] font-semibold" : "text-[#6e6e73] hover:text-[#1d1d1f] hover:bg-black/5"}`}
        >
          <img src="/game-mode-icon.png?v=2" alt="" className="w-10 h-10 object-contain" />
          <span className="text-sm font-medium leading-tight">경기 방식</span>
        </button>
        <button
          type="button"
          onClick={() => { setNavView("record"); setSelectedGameId(null); }}
          className={`flex flex-col items-center gap-0.5 py-2 px-4 min-w-0 rounded-xl transition-colors btn-tap ${navView === "record" ? "bg-[#0071e3]/10 text-[#0071e3] font-semibold" : "text-[#6e6e73] hover:text-[#1d1d1f] hover:bg-black/5"}`}
        >
          <img src="/game-list-icon.png" alt="" className="w-10 h-10 object-contain" />
          <span className="text-sm font-medium leading-tight">경기 목록</span>
        </button>
        <button
          type="button"
          onClick={() => setNavView("myinfo")}
          className={`relative flex flex-col items-center gap-0.5 py-2 px-4 min-w-0 rounded-xl transition-colors btn-tap ${navView === "myinfo" ? "bg-[#0071e3]/10 text-[#0071e3] font-semibold" : "text-[#6e6e73] hover:text-[#1d1d1f] hover:bg-black/5"} ${myInfo.profileImageUrl ? "ring-2 ring-green-500/70 ring-inset" : ""}`}
        >
          {myInfo.profileImageUrl && (
            <span className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-green-500 shrink-0" aria-hidden title="로그인됨" />
          )}
          <img src="/myinfo-icon.png" alt="" className="w-10 h-10 object-contain" />
          <span className="text-sm font-medium leading-tight">경기 이사</span>
        </button>
      </nav>

      {/* 경기 생성 전 확인 모달 */}
      {shareToast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40 px-4 py-2 rounded-lg bg-slate-800 text-white text-sm shadow-lg" role="status">
          {shareToast}
        </div>
      )}
      {showRegenerateConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50" aria-modal="true" role="alertdialog" aria-labelledby="regenerate-confirm-title">
          <div className="bg-white rounded-2xl shadow-xl max-w-sm w-full p-4 space-y-3">
            <p id="regenerate-confirm-title" className="text-sm text-slate-700 leading-relaxed">
              적용하면 현재 경기 명단 기준으로 경기 현황이 다시 생성됩니다. 지금까지 입력한 경기 결과·설정이 모두 변경됩니다. 계속하시겠습니까?
            </p>
            <div className="flex gap-2 justify-end">
              <button
                type="button"
                onClick={() => setShowRegenerateConfirm(false)}
                className="px-4 py-2 rounded-xl text-sm font-medium text-slate-700 bg-slate-100 hover:bg-slate-200"
              >
                취소
              </button>
              <button
                type="button"
                onClick={() => {
                  doMatch();
                  setShowRegenerateConfirm(false);
                }}
                className="px-4 py-2 rounded-xl text-sm font-semibold text-white bg-[#0071e3] hover:bg-[#0077ed]"
              >
                계속
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function Home() {
  return <GameView gameId={null} />;
}
