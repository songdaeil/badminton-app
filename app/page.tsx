"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { addGameToList, createGameId, DEFAULT_GAME_SETTINGS, DEFAULT_MYINFO, loadGame, loadGameList, loadMyInfo, removeGameFromList, saveGame, saveMyInfo } from "@/lib/game-storage";
import type { GameData, GameSettings, MyInfo } from "@/lib/game-storage";
import { ensureFirebase, getAuthInstance, getDb } from "@/lib/firebase";
import { getCurrentUserUid, getRemoteProfile, setRemoteProfile } from "@/lib/profile-sync";
import { addSharedGame, deleteSharedGame, getFirestorePayloadSize, getSharedGame, isSyncAvailable, setSharedGame, subscribeSharedGame } from "@/lib/sync";
import {
  getCurrentEmailUser,
  isEmailAuthAvailable,
  sendVerificationEmailAgain,
  signInWithEmail as signInWithEmailAuth,
  signOutEmail,
  signUpWithEmail,
  subscribeEmailAuthState,
} from "@/lib/email-auth";
import type { AuthUserSnapshot } from "@/lib/email-auth";
import {
  confirmPhoneCode,
  getCurrentPhoneUser,
  isPhoneAuthAvailable,
  startPhoneAuth,
  signOutPhone,
} from "@/lib/phone-auth";
import { onAuthStateChanged, type ConfirmationResult } from "firebase/auth";
import type { GameMode, Grade, Member, Match } from "./types";
import { IconCategorySword, IconCategoryUser, IconCategoryUsers, IconCategoryUsersRound } from "./components/category-icons";
import { NavIconGameList, NavIconGameMode, NavIconMyInfo } from "./components/nav-icons";
import { useGameListSync } from "@/app/hooks/useGameListSync";
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
    createdByUid: data.createdByUid ?? undefined,
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
      createdByUid: typeof p.createdByUid === "string" ? p.createdByUid : undefined,
    };
  } catch {
    return null;
  }
}

/** 저장된 경기(score1/score2 있는 것)만으로 멤버별 승/패/득실차 재계산 → 경기 명단 state 갱신용 */
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

/** 경기 결과 전용: 경기 현황(matches)만으로 참가 멤버와 승/패/득실차 산출. 명단 삭제와 무관하게 현황 기준만 따름 */
function buildRankingFromMatchesOnly(matches: Match[], gradeOrder: Record<string, number>): Member[] {
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

/** 경기 방식 카테고리 (상단 탭). 이미지 참고: 복식/단식/대항전/단체 등 */
const GAME_CATEGORIES = [
  { id: "doubles", label: "복식", Icon: IconCategoryUsers },
  { id: "singles", label: "단식", Icon: IconCategoryUser },
  { id: "contest", label: "대항전", Icon: IconCategorySword },
  { id: "team", label: "단체", Icon: IconCategoryUsersRound },
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

/** 저장 시각을 짧게 표시 (M/D HH:mm:ss) — 저장 여부 확인용 */
function formatSavedAt(iso?: string | null): string {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    const h = d.getHours().toString().padStart(2, "0");
    const min = d.getMinutes().toString().padStart(2, "0");
    const sec = d.getSeconds().toString().padStart(2, "0");
    return `${d.getMonth() + 1}/${d.getDate()} ${h}:${min}:${sec}`;
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
  if (gameModeId === "individual" || gameModeId === "individual_b") {
    const target = getTargetTotalGames(members.length);
    return buildRoundRobinMatches(members, target);
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
  /** 앱 최초 실행 시 전체화면 로그인 화면 통과 여부 (세션 기준, 건너뛰기/로그인 후 메인 표시) */
  const [loginGatePassed, setLoginGatePassed] = useState(false);
  /** 로그인한 사용자 UID (프로필 Firestore 동기화용) */
  const [authUid, setAuthUid] = useState<string | null>(null);
  /** 로그인 후 프로필 업로드 완료 여부 (true: 원격 로드됨 또는 업로드 성공. 이전에만 경기 방식·경기 목록 이용 가능) */
  const [hasUploadedProfileAfterLogin, setHasUploadedProfileAfterLogin] = useState(false);
  /** 전화번호 로그인: 단계(idle | sending | code), 입력값, 에러, 인증 결과 */
  const [phoneStep, setPhoneStep] = useState<"idle" | "sending" | "code" | "error">("idle");
  const [phoneNumberInput, setPhoneNumberInput] = useState("");
  const [phoneCodeInput, setPhoneCodeInput] = useState("");
  const [phoneError, setPhoneError] = useState("");
  const phoneConfirmationResultRef = useRef<ConfirmationResult | null>(null);
  /** 이메일 로그인: 입력값, 에러, 진행 중 */
  const [emailInput, setEmailInput] = useState("");
  const [passwordInput, setPasswordInput] = useState("");
  const [emailError, setEmailError] = useState("");
  const [emailLoading, setEmailLoading] = useState(false);
  /** 이메일 인증 대기: Firebase Auth 이메일 사용자(미인증 시 활동 불가) */
  const [authEmailUser, setAuthEmailUser] = useState<AuthUserSnapshot>(null);
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
  /** 나의 정보에서 로그아웃 등 안내 메시지 (잠깐 표시) */
  const [loginMessage, setLoginMessage] = useState<string | null>(null);
  /** 나의 프로필: 상세 수정 폼 열림 여부 */
  const [profileEditOpen, setProfileEditOpen] = useState(false);
  /** 프로필 수정 창 퇴장 애니메이션 재생 중 (좌→우 슬라이드 아웃 후 언마운트) */
  const [profileEditClosing, setProfileEditClosing] = useState(false);
  /** 경기 상세 퇴장 애니메이션 재생 중 (우측으로 슬라이드 아웃 후 목록으로) */
  const [recordDetailClosing, setRecordDetailClosing] = useState(false);
  /** 경기 생성 전 확인 모달 (종료/진행 중인 경기 있을 때) */
  const [showRegenerateConfirm, setShowRegenerateConfirm] = useState(false);
  /** 경기 생성 후 명단이 바뀌지 않았으면 버튼 비활성화. 명단 변경 시 true로 바꿔 다시 활성화 */
  const [rosterChangedSinceGenerate, setRosterChangedSinceGenerate] = useState(true);
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
  /** 경기 요약(이름/날짜/시간/장소/승점) 입력 포커스 중이면 원격 데이터로 덮어쓰지 않음 → 백스페이스 등 편집 정상 동작 */
  const gameSummaryFocusedRef = useRef(false);
  /** 명단 추가/삭제 직후 이 시간(ms)까지는 원격 members 적용 스킵 → 추가가 즉시 덮어씌워지는 것 방지 */
  const rosterEditCooldownUntilRef = useRef(0);
  /** 진행 버튼(진행/가능 토글) 누른 직후 이 시간(ms)까지는 원격 playingMatchIds 적용 스킵 → 다른 경기로 진행 옮겨도 유지 */
  const playingSelectionCooldownUntilRef = useRef(0);
  /** 경기 현황 저장 버튼 누른 직후 이 시간(ms)까지는 원격 matches/점수 적용 스킵 → 저장 후 다시 돌아가는 현상 방지 */
  const saveResultCooldownUntilRef = useRef(0);
  /** 공유 경기 진입 후 로드 직후 이 시간(ms) 동안은 구독 첫 스냅샷으로 state 덮어쓰지 않음 → 경기 생성 등이 동작하도록 */
  const sharedGameLoadDoneAtRef = useRef(0);
  /** 경기 생성 직후 이 시간(ms) 동안은 구독의 빈/구버전 원격 데이터로 matches 덮어쓰지 않음 */
  const matchGenerateDoneAtRef = useRef(0);
  /** 경기 결과 저장 연타 시 Firestore 업로드 한 번만(디바운스) → 완료 순서 뒤바뀜으로 이전 값 덮어쓰기 방지 */
  const saveResultFirestoreTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const SAVE_RESULT_FIRESTORE_DEBOUNCE_MS = 500;
  /** 로드/구독에서 '현재 명단·경기'와 비교할 때 사용 (state와 동기화) */
  const membersRef = useRef<Member[]>([]);
  const matchesRef = useRef<Match[]>([]);
  membersRef.current = members;
  matchesRef.current = matches;
  useEffect(() => {
    scoreInputsRef.current = scoreInputs;
  }, [scoreInputs]);
  /** 경기 목록에서 공유(shareId) 카드 최신 데이터 갱신 후 리스트 다시 그리기용 */
  const [listRefreshKey, setListRefreshKey] = useState(0);
  const { syncGameListToFirebase, refreshListFromRemote } = useGameListSync(
    authUid,
    useCallback(() => setListRefreshKey((k) => k + 1), [])
  );
  const carouselViewportRef = useRef<HTMLDivElement>(null);
  const panelScrollRefs = useRef<(HTMLDivElement | null)[]>([null, null, null]);
  /** 경기 목록 상세·프로필 수정 등 섹션 하위 오버레이 열림 시 true → 캐러셀 스와이프 무시 */
  const overlayOpenRef = useRef(false);
  /** 오버레이(도움말·확인 모달) 스와이프 제스처용 */
  const overlayTouchStartRef = useRef({ x: 0, y: 0 });
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
      setRosterChangedSinceGenerate(true);
      setMounted(true);
      return;
    }
    const id = effectiveGameId;
    let cancelled = false;
    (async () => {
      let data = loadGame(id);
      if (data.shareId && isSyncAvailable()) {
        const remote = await getSharedGame(data.shareId);
        if (cancelled) return;
        if (remote) {
          const localSaved = (data.matches ?? []).filter((m) => m.score1 != null || m.score2 != null).length;
          const remoteSaved = (remote.matches ?? []).filter((m) => m.score1 != null || m.score2 != null).length;
          if (localSaved > remoteSaved) {
            saveGame(id, { ...data, shareId: data.shareId });
            setSharedGame(data.shareId, { ...data, shareId: data.shareId }).catch(() => {});
          } else {
            saveGame(id, { ...remote, shareId: data.shareId });
            data = { ...remote, shareId: data.shareId };
          }
        }
      }
      if (cancelled) return;
      const loadedMembers = data.members ?? [];
      const loadedMatches = data.matches ?? [];
      const hadEmptyLoad = loadedMembers.length === 0 && loadedMatches.length === 0;
      const userAlreadyAddedMembers = hadEmptyLoad && membersRef.current.length > 0;
      if (!userAlreadyAddedMembers) {
        const membersWithCorrectStats = recomputeMemberStatsFromMatches(loadedMembers, loadedMatches);
        setMembers(membersWithCorrectStats);
        setMatches(loadedMatches);
        setMyProfileMemberId(
          data.myProfileMemberId ?? loadedMembers.find((m) => m.name === myInfo.name?.trim())?.id ?? null
        );
        const inputs: Record<string, { s1: string; s2: string }> = {};
        for (const m of loadedMatches) {
          inputs[m.id] = { s1: m.score1 != null ? String(m.score1) : "", s2: m.score2 != null ? String(m.score2) : "" };
        }
        setScoreInputs(inputs);
        const matchIdSet = new Set(loadedMatches.map((m) => String(m.id)));
        const validPlayingIds = (data.playingMatchIds ?? []).filter((id) => matchIdSet.has(id));
        setSelectedPlayingMatchIds(validPlayingIds);
        setRosterChangedSinceGenerate(loadedMatches.length === 0);
      }
      setHighlightMemberId(null);
      setGameName(typeof data.gameName === "string" && data.gameName.trim() ? data.gameName.trim() : "");
      const loadedModeId = data.gameMode && GAME_MODES.some((m) => m.id === data.gameMode) ? data.gameMode! : GAME_MODES[0].id;
      setGameModeId(loadedModeId);
      const loadedMode = GAME_MODES.find((m) => m.id === loadedModeId) ?? GAME_MODES[0];
      setGameModeCategoryId(loadedMode.categoryId ?? GAME_CATEGORIES[0].id);
      const baseSettings = data.gameSettings ?? { ...DEFAULT_GAME_SETTINGS };
      const rawScore = baseSettings.scoreLimit;
      const validScore = typeof rawScore === "number" && rawScore >= 1 && rawScore <= 99 ? rawScore : (loadedMode.defaultScoreLimit ?? 21);
      const validTime = TIME_OPTIONS_30MIN.includes(baseSettings.time) ? baseSettings.time : TIME_OPTIONS_30MIN[0];
      setGameSettings({ ...baseSettings, scoreLimit: validScore, time: validTime });
      setMounted(true);
      if (data.shareId) sharedGameLoadDoneAtRef.current = Date.now();
    })();
    return () => { cancelled = true; };
  }, [effectiveGameId]);

  /** 경기 상세 이탈 시(목록으로·다른 섹션 이동 등) 공통: 디바운스·타이머 정리 후 로컬 최신값 저장 및 Firestore 업로드 */
  useEffect(() => {
    return () => {
      if (effectiveGameId == null) return;
      const leavingId = effectiveGameId;
      if (saveDebounceTimerRef.current) {
        clearTimeout(saveDebounceTimerRef.current);
        saveDebounceTimerRef.current = null;
      }
      const pending = saveDebounceRef.current;
      if (pending && pending.id === leavingId) {
        saveGame(leavingId, pending.payload);
        saveDebounceRef.current = null;
      }
      if (saveResultFirestoreTimerRef.current) {
        clearTimeout(saveResultFirestoreTimerRef.current);
        saveResultFirestoreTimerRef.current = null;
      }
      const data = loadGame(leavingId);
      saveGame(leavingId, data);
      if (data.shareId && isSyncAvailable()) {
        setSharedGame(data.shareId, data).catch(() => {});
      }
    };
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
      const avoidOverwriteMs = 2500;
      if (sharedGameLoadDoneAtRef.current > 0 && Date.now() - sharedGameLoadDoneAtRef.current < avoidOverwriteMs) return;
      const remoteMatchCount = remote.matches?.length ?? 0;
      const justGeneratedLocally =
        matchGenerateDoneAtRef.current > 0 &&
        Date.now() - matchGenerateDoneAtRef.current < 3000 &&
        remoteMatchCount < matchesRef.current.length;
      if (justGeneratedLocally) return;
      skipNextFirestorePush.current = true;
      saveGame(effectiveGameId, remote);
      const inSaveResultCooldown = Date.now() < saveResultCooldownUntilRef.current;
      const inRosterCooldown = Date.now() < rosterEditCooldownUntilRef.current;
      if (!inRosterCooldown && !inSaveResultCooldown) {
        const membersWithCorrectStats = recomputeMemberStatsFromMatches(remote.members, remote.matches);
        setMembers(membersWithCorrectStats);
        setMyProfileMemberId(
          remote.myProfileMemberId ?? remote.members.find((m) => m.name === myInfo.name?.trim())?.id ?? null
        );
      }
      if (!gameSummaryFocusedRef.current) {
        setGameName(typeof remote.gameName === "string" && remote.gameName.trim() ? remote.gameName.trim() : "");
        const loadedModeId = remote.gameMode && GAME_MODES.some((m) => m.id === remote.gameMode) ? remote.gameMode! : GAME_MODES[0].id;
        setGameModeId(loadedModeId);
        const loadedMode = GAME_MODES.find((m) => m.id === loadedModeId) ?? GAME_MODES[0];
        setGameModeCategoryId(loadedMode.categoryId ?? GAME_CATEGORIES[0].id);
        const baseSettings = remote.gameSettings ?? { ...DEFAULT_GAME_SETTINGS };
        const rawScore = baseSettings.scoreLimit;
        const validScore = typeof rawScore === "number" && rawScore >= 1 && rawScore <= 99 ? rawScore : (loadedMode.defaultScoreLimit ?? 21);
        const validTime = TIME_OPTIONS_30MIN.includes(baseSettings.time) ? baseSettings.time : TIME_OPTIONS_30MIN[0];
        setGameSettings({ ...baseSettings, scoreLimit: validScore, time: validTime });
      }
      if (!inSaveResultCooldown) {
        setMatches(remote.matches);
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
      }
      const inPlayingCooldown = Date.now() < playingSelectionCooldownUntilRef.current;
      if (!inPlayingCooldown) {
        const matchIdSet = new Set(remote.matches.map((m) => String(m.id)));
        const validPlayingIds = (remote.playingMatchIds ?? []).filter((id) => matchIdSet.has(id));
        setSelectedPlayingMatchIds(validPlayingIds);
      }
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
      sessionStorage.setItem(LOGIN_GATE_KEY, "1");
      setLoginGatePassed(true);
      return;
    }
    // Firestore 동기화: 먼저 getSharedGame 시도(내부에서 ensureFirebase 호출). 없으면 구형 base64 링크 시도
    const passGateFromShare = () => {
      sessionStorage.setItem(LOGIN_GATE_KEY, "1");
      setLoginGatePassed(true);
    };
    getSharedGame(share).then((data) => {
      if (data) {
        const newId = createGameId();
        saveGame(newId, {
          ...data,
          playingMatchIds: data.playingMatchIds ?? [],
          shareId: share,
        });
        addGameToList(newId);
        syncGameListToFirebase({ added: newId });
        setNavView("record");
        setSelectedGameId(null);
        router.replace("/?view=record");
        passGateFromShare();
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
      syncGameListToFirebase({ added: newId });
      setNavView("record");
      setSelectedGameId(null);
      router.replace("/?view=record");
      passGateFromShare();
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
      syncGameListToFirebase({ added: newId });
      setNavView("record");
      setSelectedGameId(null);
      router.replace("/?view=record");
      passGateFromShare();
    });
  }, [searchParams, router, gameId, syncGameListToFirebase]);

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

  const LOGIN_GATE_KEY = "badminton_login_passed";

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (sessionStorage.getItem(LOGIN_GATE_KEY) === "1") setLoginGatePassed(true);
  }, []);

  /** 로그인 UID 구독 (프로필 Firestore 동기화용) */
  useEffect(() => {
    const auth = getAuthInstance();
    if (!auth) return;
    const unsub = onAuthStateChanged(auth, (user) => {
      setAuthUid(user?.uid ?? null);
    });
    return unsub;
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const info = loadMyInfo();
    setMyInfo(info);
  }, []);

  /** 로그인 시 Firestore에서 프로필 불러와 로컬에 반영. 나의 프로필에 UID 내포(연동 근거) */
  useEffect(() => {
    if (!authUid) return;
    getRemoteProfile(authUid).then((remote) => {
      const withUid = { ...(remote ?? {}), uid: authUid } as MyInfo;
      if (!withUid.name) withUid.name = "";
      if (!withUid.gender) withUid.gender = "M";
      if (remote) {
        setMyInfo(withUid);
        saveMyInfo(withUid);
        setHasUploadedProfileAfterLogin(true);
      } else {
        setMyInfo((prev) => {
          const next = { ...prev, uid: authUid };
          saveMyInfo(next);
          return next;
        });
        setHasUploadedProfileAfterLogin(false);
      }
    });
  }, [authUid]);

  /** 프로필 필수 항목 유무 (동기화 후 사용자가 지워도 검사) */
  const hasRequiredProfileFields = (): boolean => {
    if (!myInfo.name?.trim()) return false;
    if (!myInfo.birthDate?.trim()) return false;
    const g = myInfo.grade ?? "D";
    if (g !== "A" && g !== "B" && g !== "C" && g !== "D") return false;
    return true;
  };
  /** 업로드까지 했고, 현재 프로필에 필수 항목이 모두 있으면 완성 (아이콘 채움·경기 방식/목록 이용 가능) */
  const isProfileComplete = hasUploadedProfileAfterLogin && hasRequiredProfileFields();

  /** 프로필 완성 전에는 경기 방식·경기 목록 비활성: 해당 탭이면 myinfo로 이동 */
  useEffect(() => {
    if (!authUid || isProfileComplete) return;
    if (navView === "setting" || navView === "record") setNavView("myinfo");
  }, [authUid, isProfileComplete, navView]);

  const NAV_ORDER: ("setting" | "record" | "myinfo")[] = ["setting", "record", "myinfo"];
  const navIndex = NAV_ORDER.indexOf(navView);

  /** 경기 목록 상세·프로필 수정 열림 시 캐러셀 스와이프 무시용 ref 동기화 */
  useEffect(() => {
    overlayOpenRef.current = !!(selectedGameId || profileEditOpen || profileEditClosing);
  }, [selectedGameId, profileEditOpen, profileEditClosing]);

  /** 프로필을 Firestore에 업로드 (업로드 후에만 경기 방식·경기 목록 이용 가능) */
  const uploadProfileToFirestore = useCallback(async () => {
    const uid = getCurrentUserUid();
    if (!uid) return;
    if (!myInfo.name?.trim()) {
      setLoginMessage("이름을 입력한 뒤 업로드해 주세요.");
      setTimeout(() => setLoginMessage(null), 3000);
      return;
    }
    if (!myInfo.birthDate?.trim()) {
      setLoginMessage("생년월일을 입력한 뒤 업로드해 주세요.");
      setTimeout(() => setLoginMessage(null), 3000);
      return;
    }
    const ok = await setRemoteProfile(uid, myInfo);
    if (ok) {
      setHasUploadedProfileAfterLogin(true);
      setLoginMessage("프로필이 클라우드에 업로드되었습니다.");
      setTimeout(() => setLoginMessage(null), 3000);
    } else {
      setLoginMessage("업로드에 실패했습니다.");
      setTimeout(() => setLoginMessage(null), 3000);
    }
  }, [myInfo]);

  /** 이메일 인증 상태 구독: 인증 완료 시 로그인 통과 처리(유령 회원 방지) */
  useEffect(() => {
    if (!isEmailAuthAvailable()) return;
    const unsubscribe = subscribeEmailAuthState((user) => {
      setAuthEmailUser(user);
      if (user?.emailVerified && typeof window !== "undefined") {
        sessionStorage.setItem(LOGIN_GATE_KEY, "1");
        setLoginGatePassed(true);
      }
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (!mounted || effectiveGameId === null) return;
    const existing = loadGame(effectiveGameId);
    const membersToSave =
      myProfileMemberId != null
        ? members.map((m) =>
            m.id === myProfileMemberId
              ? { ...m, name: myInfo.name, gender: myInfo.gender, grade: myInfo.grade ?? "D" }
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
      createdByUid: existing.createdByUid ?? undefined,
      playingMatchIds: selectedPlayingMatchIds,
      importedFromShare: existing.importedFromShare ?? undefined,
      shareId: existing.shareId ?? undefined,
    };
    /** 공유 경기인데 state는 아직 비어 있고 로컬에는 데이터가 있음 → 진입 직후. 빈 payload로 Firebase 쓰면 서버 초기화 후 다른 기기로 퍼져 데이터 유실되므로 이번 run에서는 저장/업로드 스킵 */
    const isSharedButStateNotLoaded =
      existing.shareId &&
      members.length === 0 &&
      matches.length === 0 &&
      ((existing.members?.length ?? 0) > 0 || (existing.matches?.length ?? 0) > 0);
    if (isSharedButStateNotLoaded) return;
    /** 로컬 저장 후, 공유 경기(shareId)면 Firestore 업로드. 빈 payload로 로컬/서버 덮어쓰기 방지(데이터 유실 방지). */
    const runSave = (id: string, data: GameData) => {
      const localBefore = loadGame(id);
      const wouldOverwriteWithEmpty =
        data.shareId &&
        (data.members?.length ?? 0) === 0 &&
        (data.matches?.length ?? 0) === 0 &&
        ((localBefore.members?.length ?? 0) > 0 || (localBefore.matches?.length ?? 0) > 0);
      if (wouldOverwriteWithEmpty) return;
      saveGame(id, data);
      if (data.shareId && isSyncAvailable()) {
        if (skipNextFirestorePush.current) {
          skipNextFirestorePush.current = false;
        } else {
          setSharedGame(data.shareId, data)
            .then((ok) => { if (ok) setLastFirestoreUploadBytes(getFirestorePayloadSize(data)); })
            .catch(() => {});
        }
      }
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


  const addGameToRecord = useCallback(() => {
    const id = createGameId();
    const mode = GAME_MODES.find((m) => m.id === gameModeId) ?? GAME_MODES[0];
    const defaultScore = mode.defaultScoreLimit ?? 21;
    const creatorName = myProfileMemberId ? members.find((m) => m.id === myProfileMemberId)?.name : null;
    const creatorUid = myInfo.uid ?? getCurrentUserUid();
    const payload: GameData = {
      members: [],
      matches: [],
      gameName: undefined,
      gameMode: gameModeId,
      gameSettings: { ...DEFAULT_GAME_SETTINGS, scoreLimit: defaultScore },
      createdAt: new Date().toISOString(),
      createdBy: myProfileMemberId ?? null,
      createdByName: (creatorName ?? myInfo.name) || "-",
      createdByUid: creatorUid ?? null,
    };
    saveGame(id, payload);
    addGameToList(id);
    syncGameListToFirebase({ added: id });
    if (creatorUid && isSyncAvailable()) {
      addSharedGame(payload)
        .then((newId) => {
          if (newId) {
            saveGame(id, { ...payload, shareId: newId });
            setLastFirestoreUploadBytes(getFirestorePayloadSize({ ...payload, shareId: newId }));
          }
        })
        .catch(() => {});
    }
    setSelectedGameId(null);
    setNavView("record");
  }, [gameModeId, myProfileMemberId, members, myInfo.name, syncGameListToFirebase]);

  const handleShareGame = useCallback(() => {
    if (effectiveGameId === null) return;
    const id = createGameId();
    const existing = loadGame(effectiveGameId);
    const creatorUid = myInfo.uid ?? getCurrentUserUid();
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
      createdByUid: existing.createdByUid ?? creatorUid ?? undefined,
    });
    router.push(`/game/${id}`);
  }, [effectiveGameId, members, matches, gameName, gameModeId, gameSettings, myProfileMemberId, router]);

  /** 목록 카드에서 해당 경기 삭제. Firestore에 공유된 경기면 원격 문서도 삭제. UID 기준 경기 목록 동기화에도 반영. */
  const handleDeleteCard = useCallback((gameId: string) => {
    const data = loadGame(gameId);
    if (data.shareId && isSyncAvailable()) {
      deleteSharedGame(data.shareId).catch(() => {});
    }
    removeGameFromList(gameId);
    syncGameListToFirebase({ removed: gameId });
    setSelectedGameId(null);
    setListMenuOpenId(null);
  }, [syncGameListToFirebase]);

  /** 목록 카드에서 해당 경기 복사: 경기 명단 단계까지만 복사, 경기 현황은 제외 → 복사 후 명단 재편집·경기 생성 가능 */
  const handleCopyCard = useCallback((gameId: string) => {
    const existing = loadGame(gameId);
    const newId = createGameId();
    const creatorUid = myInfo.uid ?? getCurrentUserUid();
    const payload: GameData = {
      members: existing.members ?? [],
      matches: [],
      gameName: existing.gameName ?? undefined,
      gameMode: existing.gameMode,
      gameSettings: existing.gameSettings ?? { ...DEFAULT_GAME_SETTINGS },
      myProfileMemberId: existing.myProfileMemberId ?? undefined,
      createdAt: new Date().toISOString(),
      createdBy: null,
      createdByName: myInfo.name || "-",
      createdByUid: creatorUid ?? null,
      playingMatchIds: [],
    };
    saveGame(newId, payload);
    addGameToList(newId);
    syncGameListToFirebase({ added: newId });
    if (creatorUid && isSyncAvailable()) {
      addSharedGame(payload)
        .then((shareId) => {
          if (shareId) {
            saveGame(newId, { ...payload, shareId });
            setLastFirestoreUploadBytes(getFirestorePayloadSize({ ...payload, shareId }));
          }
        })
        .catch(() => {});
    }
    setListMenuOpenId(null);
    setSelectedGameId(null);
  }, [myInfo.name, syncGameListToFirebase]);

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

  /** 경기 방식에서 선정한 로직으로만 경기 생성. 생성 직후 즉시 저장·공유 반영하여 첫 진입 시에도 경기 현황 유지. */
  const doMatch = useCallback(() => {
    if (effectiveGameId === null) return;
    const mode = GAME_MODES.find((m) => m.id === gameModeId);
    if (!mode || members.length < mode.minPlayers || members.length > mode.maxPlayers) return;
    const shuffled = [...members].sort(() => Math.random() - 0.5);
    const newMatches = generateMatchesByGameMode(gameModeId, shuffled);
    if (newMatches.length === 0) return;
    const inputs: Record<string, { s1: string; s2: string }> = {};
    for (const m of newMatches) {
      inputs[m.id] = { s1: "", s2: "" };
    }
    const membersReset = members.map((m) => ({ ...m, wins: 0, losses: 0, pointDiff: 0 }));
    const membersToSave =
      myProfileMemberId != null
        ? membersReset.map((m) =>
            m.id === myProfileMemberId
              ? { ...m, name: myInfo.name, gender: myInfo.gender, grade: myInfo.grade ?? "D" }
              : m
          )
        : membersReset;
    setMatches(newMatches);
    setScoreInputs(inputs);
    setSelectedPlayingMatchIds([]);
    setMembers((prev) =>
      prev.map((m) => ({ ...m, wins: 0, losses: 0, pointDiff: 0 }))
    );
    setRosterChangedSinceGenerate(false);
    matchGenerateDoneAtRef.current = Date.now();

    const existing = loadGame(effectiveGameId);
    const payload: GameData = {
      members: membersToSave,
      matches: newMatches,
      gameName: gameName && gameName.trim() ? gameName.trim() : undefined,
      gameMode: gameModeId,
      gameSettings,
      myProfileMemberId: myProfileMemberId ?? undefined,
      createdAt: existing.createdAt ?? undefined,
      createdBy: existing.createdBy ?? undefined,
      createdByName: existing.createdByName ?? undefined,
      createdByUid: existing.createdByUid ?? undefined,
      playingMatchIds: [],
      importedFromShare: existing.importedFromShare ?? undefined,
      shareId: existing.shareId ?? undefined,
    };
    saveGame(effectiveGameId, payload);
    if (payload.shareId && isSyncAvailable()) {
      setSharedGame(payload.shareId, payload)
        .then((ok) => { if (ok) setLastFirestoreUploadBytes(getFirestorePayloadSize(payload)); })
        .catch(() => {});
    }
  }, [effectiveGameId, gameModeId, gameName, gameSettings, members, myProfileMemberId, myInfo.name, myInfo.gender, myInfo.grade]);

  const scoreLimit = Math.max(1, gameSettings.scoreLimit || 21);

  const saveResult = useCallback(
    (matchId: string) => {
      const input = scoreInputs[matchId];
      if (!input) return;
      const s1 = input.s1.trim() === "" ? 0 : parseInt(input.s1, 10);
      const s2 = input.s2.trim() === "" ? 0 : parseInt(input.s2, 10);
      if (Number.isNaN(s1) || Number.isNaN(s2) || s1 < 0 || s2 < 0) return;
      if (s1 > scoreLimit || s2 > scoreLimit) return;
      if (effectiveGameId === null) return;
      const existing = loadGame(effectiveGameId);
      const baseMatches = existing.matches ?? matches;
      const match = baseMatches.find((m) => m.id === matchId);
      if (!match) return;

      saveResultCooldownUntilRef.current = Date.now() + 3000;
      const now = new Date().toISOString();
      const savedByName = myInfo.name?.trim() || null;
      const record = { at: now, by: myProfileMemberId ?? "", savedByName };

      /* 연타 저장 시 state가 아직 갱신 전일 수 있으므로, 로컬에 마지막 저장된 matches 기준으로 이 매치만 반영 */
      const nextMatches = baseMatches.map((m) =>
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
      const nextMembers = recomputeMemberStatsFromMatches(existing.members ?? members, nextMatches);
      setMatches(nextMatches);
      setMembers((prev) => recomputeMemberStatsFromMatches(prev, nextMatches));
      setSelectedPlayingMatchIds((prev) => prev.filter((id) => id !== matchId));
      setScoreInputs((prev) => ({ ...prev, [matchId]: { s1: String(s1), s2: String(s2) } }));

      const membersToSave =
        myProfileMemberId != null
          ? nextMembers.map((m) =>
              m.id === myProfileMemberId
                ? { ...m, name: myInfo.name, gender: myInfo.gender, grade: myInfo.grade ?? "D" }
                : m
            )
          : nextMembers;
      const payload: GameData = {
        ...existing,
        members: membersToSave,
        matches: nextMatches,
        gameName: existing.gameName ?? (gameName && gameName.trim() ? gameName.trim() : undefined),
        gameMode: existing.gameMode ?? gameModeId,
        gameSettings: existing.gameSettings ?? gameSettings,
        myProfileMemberId: existing.myProfileMemberId ?? myProfileMemberId ?? undefined,
        playingMatchIds: (existing.playingMatchIds ?? selectedPlayingMatchIds).filter((id) => id !== matchId),
      };
      saveGame(effectiveGameId, payload);
      if (payload.shareId && isSyncAvailable()) {
        if (saveResultFirestoreTimerRef.current) clearTimeout(saveResultFirestoreTimerRef.current);
        const gameIdToUpload = effectiveGameId;
        saveResultFirestoreTimerRef.current = setTimeout(() => {
          saveResultFirestoreTimerRef.current = null;
          const data = loadGame(gameIdToUpload);
          if (data.shareId && isSyncAvailable()) {
            setSharedGame(data.shareId, data)
              .then((ok) => { if (ok) setLastFirestoreUploadBytes(getFirestorePayloadSize(data)); })
              .catch(() => {});
          }
        }, SAVE_RESULT_FIRESTORE_DEBOUNCE_MS);
      }
    },
    [matches, scoreInputs, scoreLimit, myProfileMemberId, myInfo.name, myInfo.gender, myInfo.grade, effectiveGameId, gameName, gameModeId, gameSettings, members, selectedPlayingMatchIds]
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
    const max = GAME_MODES.find((m) => m.id === gameModeId)?.maxPlayers ?? 12;
    if (members.length >= max) return;
    rosterEditCooldownUntilRef.current = Date.now() + 1500;
    const newId = createId();
    const newMember: Member = { id: newId, name: trimmed, gender, grade, wins: 0, losses: 0, pointDiff: 0 };
    const nextMembers = [...members, newMember];
    setMembers(() => nextMembers);
    setRosterChangedSinceGenerate(true);
    if (effectiveGameId === null) return;
    const existing = loadGame(effectiveGameId);
    const membersToSave =
      myProfileMemberId != null
        ? nextMembers.map((m) =>
            m.id === myProfileMemberId
              ? { ...m, name: myInfo.name, gender: myInfo.gender, grade: myInfo.grade ?? "D" }
              : m
          )
        : nextMembers;
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
      createdByUid: existing.createdByUid ?? undefined,
      playingMatchIds: selectedPlayingMatchIds,
      importedFromShare: existing.importedFromShare ?? undefined,
      shareId: existing.shareId ?? undefined,
    };
    saveGame(effectiveGameId, payload);
    /* Firestore 업로드는 디바운스 runSave에서 일괄 처리 */
  }, [gameModeId, members, effectiveGameId, myProfileMemberId, myInfo.name, myInfo.gender, myInfo.grade, gameName, gameModeId, gameSettings, matches, selectedPlayingMatchIds]);

  /** 프로필로 나 추가 시 사용: 나의 프로필에 내포된 UID로 연동(linkedUid) 멤버 추가 후 '나'로 설정 */
  const addMemberAsMe = useCallback((name: string, gender: "M" | "F", grade: Grade) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const uid = myInfo.uid ?? getCurrentUserUid();
    const max = GAME_MODES.find((m) => m.id === gameModeId)?.maxPlayers ?? 12;
    if (members.length >= max) return;
    rosterEditCooldownUntilRef.current = Date.now() + 1500;
    const newId = createId();
    const newMember: Member = { id: newId, name: trimmed, gender, grade, wins: 0, losses: 0, pointDiff: 0, linkedUid: uid ?? undefined };
    const nextMembers = [...members, newMember];
    setMembers(() => nextMembers);
    setMyProfileMemberId(newId);
    setRosterChangedSinceGenerate(true);
    if (effectiveGameId === null) return;
    const existing = loadGame(effectiveGameId);
    const membersToSave = nextMembers.map((m) =>
      m.id === newId ? { ...m, name: myInfo.name, gender: myInfo.gender, grade: myInfo.grade ?? "D" } : m
    );
    const payload: GameData = {
      members: membersToSave,
      matches,
      gameName: gameName && gameName.trim() ? gameName.trim() : undefined,
      gameMode: gameModeId,
      gameSettings,
      myProfileMemberId: newId,
      createdAt: existing.createdAt ?? undefined,
      createdBy: existing.createdBy ?? undefined,
      createdByName: existing.createdByName ?? undefined,
      createdByUid: existing.createdByUid ?? undefined,
      playingMatchIds: selectedPlayingMatchIds,
      importedFromShare: existing.importedFromShare ?? undefined,
      shareId: existing.shareId ?? undefined,
    };
    saveGame(effectiveGameId, payload);
    /* Firestore 업로드는 디바운스 runSave에서 일괄 처리 */
  }, [gameModeId, myInfo.uid, members, effectiveGameId, myInfo.name, myInfo.gender, myInfo.grade, gameName, gameModeId, gameSettings, matches, selectedPlayingMatchIds]);

  const removeMember = useCallback((id: string) => {
    rosterEditCooldownUntilRef.current = Date.now() + 1500;
    const nextMembers = members.filter((m) => m.id !== id);
    setMembers(() => nextMembers);
    setRosterChangedSinceGenerate(true);
    if (myProfileMemberId === id) setMyProfileMemberId(null);
    if (effectiveGameId === null) return;
    const existing = loadGame(effectiveGameId);
    const membersToSave =
      myProfileMemberId != null && myProfileMemberId !== id
        ? nextMembers.map((m) =>
            m.id === myProfileMemberId
              ? { ...m, name: myInfo.name, gender: myInfo.gender, grade: myInfo.grade ?? "D" }
              : m
          )
        : nextMembers;
    const payload: GameData = {
      members: membersToSave,
      matches,
      gameName: gameName && gameName.trim() ? gameName.trim() : undefined,
      gameMode: gameModeId,
      gameSettings,
      myProfileMemberId: myProfileMemberId === id ? undefined : myProfileMemberId ?? undefined,
      createdAt: existing.createdAt ?? undefined,
      createdBy: existing.createdBy ?? undefined,
      createdByName: existing.createdByName ?? undefined,
      createdByUid: existing.createdByUid ?? undefined,
      playingMatchIds: selectedPlayingMatchIds,
      importedFromShare: existing.importedFromShare ?? undefined,
      shareId: existing.shareId ?? undefined,
    };
    saveGame(effectiveGameId, payload);
    /* Firestore 업로드는 디바운스 runSave에서 일괄 처리 */
  }, [members, effectiveGameId, myProfileMemberId, myInfo.name, myInfo.gender, myInfo.grade, gameName, gameModeId, gameSettings, matches, selectedPlayingMatchIds]);

  /** 경기 결과 = 경기 현황(matches)만으로 산출. 명단에서 인원 삭제해도 결과는 현황 기준으로 유지 */
  const ranking = useMemo(
    () => buildRankingFromMatchesOnly(matches, GRADE_ORDER),
    [matches]
  );

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
   * 진행 중 = 선택됐고 아직 미종료인 경기만 (종료된 경기는 진행에서 제외).
   */
  const hasPlayingInList = selectedPlayingMatchIds.some((id) => {
    const m = matches.find((x) => String(x.id) === String(id));
    return m != null && m.score1 == null && m.score2 == null;
  });
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
    playingSelectionCooldownUntilRef.current = Date.now() + 2000;
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

  if (!loginGatePassed) {
    /** 이메일로 가입/로그인했으나 아직 미인증 → 인증 메일에서 링크를 눌러야 활동 가능 */
    if (authEmailUser && !authEmailUser.emailVerified) {
      return (
        <div className="min-h-screen min-h-[100dvh] bg-[#f5f5f7] text-[#1d1d1f] flex flex-col items-center justify-center px-4 py-8">
          <div className="w-full max-w-sm flex flex-col items-center gap-6">
            <div className="text-center space-y-2">
              <h1 className="text-xl font-bold text-[#1d1d1f] tracking-tight">이메일 인증이 필요합니다</h1>
              <p className="text-sm text-slate-600">
                <span className="font-medium text-slate-700">{authEmailUser.email}</span> 주소로 인증 메일을 보냈습니다.
              </p>
              <p className="text-sm text-slate-500">
                메일에서 링크를 눌러 인증을 완료해 주세요. (스팸함도 확인해 주세요.)
              </p>
            </div>
            <div className="w-full space-y-2">
              <button
                type="button"
                disabled={emailLoading}
                onClick={async () => {
                  setEmailError("");
                  setEmailLoading(true);
                  try {
                    await ensureFirebase();
                    await sendVerificationEmailAgain();
                    setEmailError("");
                    setLoginMessage("인증 메일을 다시 보냈습니다.");
                    setTimeout(() => setLoginMessage(null), 4000);
                  } catch (e) {
                    setEmailError(e instanceof Error ? e.message : "인증 메일 전송에 실패했습니다.");
                  } finally {
                    setEmailLoading(false);
                  }
                }}
                className="w-full py-3 rounded-xl text-sm font-medium text-white bg-[#0071e3] hover:bg-[#0077ed] disabled:opacity-50 transition-colors btn-tap"
              >
                인증 메일 다시 보내기
              </button>
              <button
                type="button"
                onClick={async () => {
                  await signOutEmail();
                  setMyInfo((prev) => ({ ...prev, email: undefined }));
                  setAuthEmailUser(null);
                }}
                className="w-full py-2.5 rounded-xl text-sm font-medium text-slate-600 bg-slate-100 hover:bg-slate-200 transition-colors btn-tap"
              >
                로그아웃
              </button>
              {emailError && <p className="text-xs text-amber-600" role="alert">{emailError}</p>}
              {loginMessage && <p className="text-xs text-slate-600">{loginMessage}</p>}
            </div>
            <p className="text-center pt-2">
              <a href="/privacy.html" target="_blank" rel="noopener noreferrer" className="text-xs text-slate-500 underline hover:text-slate-700">개인정보 처리방침</a>
            </p>
          </div>
        </div>
      );
    }

    return (
      <div className="min-h-screen min-h-[100dvh] bg-[#f5f5f7] text-[#1d1d1f] flex flex-col items-center justify-center px-4 py-8">
        <div className="w-full max-w-sm flex flex-col items-center gap-8">
          <div className="text-center space-y-2">
            <h1 className="text-2xl font-bold text-[#1d1d1f] tracking-tight">경기 이사</h1>
            <p className="text-sm text-slate-500">배드민턴 경기 명단·대진·결과를 함께 관리하세요</p>
          </div>
          <div className="w-full space-y-3">
            {/* 전화번호 로그인 */}
            {isPhoneAuthAvailable() && (
              <div className="space-y-2">
                  <p className="text-xs text-slate-600 font-medium">전화번호로 로그인</p>
                  {phoneStep === "idle" && (
                    <>
                      <input
                        type="tel"
                        value={phoneNumberInput}
                        onChange={(e) => {
                          setPhoneNumberInput(e.target.value);
                          setPhoneError("");
                        }}
                        placeholder="010-1234-5678"
                        className="w-full px-3 py-2.5 rounded-xl border border-slate-200 bg-white text-sm focus:outline-none focus:ring-2 focus:ring-[#0071e3]/25 focus:border-[#0071e3]"
                        aria-label="전화번호"
                      />
                      <button
                        type="button"
                        onClick={async () => {
                          const trimmed = phoneNumberInput.replace(/\s/g, "").trim();
                          if (!trimmed || trimmed.replace(/\D/g, "").length < 10) {
                            setPhoneError("올바른 전화번호를 입력해 주세요.");
                            return;
                          }
                          setPhoneError("");
                          setPhoneStep("sending");
                          try {
                            await ensureFirebase();
                            const result = await startPhoneAuth(trimmed);
                            phoneConfirmationResultRef.current = result;
                            setPhoneStep("code");
                            setPhoneCodeInput("");
                          } catch (e: unknown) {
                            let msg = "인증문자 전송에 실패했습니다.";
                            const code = e && typeof e === "object" && "code" in e ? (e as { code: string }).code : "";
                            if (code === "auth/configuration-not-found") {
                              msg = "Firebase 콘솔에서 전화번호 로그인을 켜주세요. Authentication → Sign-in method → 전화번호 사용 설정, 그리고 허용 도메인에 이 사이트 주소를 추가해 주세요.";
                            } else if (code === "auth/billing-not-enabled") {
                              msg = "전화번호 로그인은 Firebase Blaze 요금제에서만 사용할 수 있습니다. Firebase 콘솔 → 프로젝트 설정 → 사용량 및 결제 → Blaze로 업그레이드 후 다시 시도해 주세요.";
                            } else if (e instanceof Error) {
                              msg = e.message;
                            }
                            setPhoneError(msg);
                            setPhoneStep("idle");
                          }
                        }}
                        className="w-full py-2.5 rounded-xl text-sm font-medium bg-slate-800 text-white hover:bg-slate-700 transition-colors btn-tap"
                      >
                        인증문자 보내기
                      </button>
                    </>
                  )}
                  {phoneStep === "sending" && (
                    <p className="text-center text-sm text-slate-500 py-2">전송 중...</p>
                  )}
                  {phoneStep === "code" && (
                    <>
                      <input
                        type="text"
                        inputMode="numeric"
                        maxLength={6}
                        value={phoneCodeInput}
                        onChange={(e) => {
                          setPhoneCodeInput(e.target.value.replace(/\D/g, "").slice(0, 6));
                          setPhoneError("");
                        }}
                        placeholder="인증번호 6자리"
                        className="w-full px-3 py-2.5 rounded-xl border border-slate-200 bg-white text-sm font-numeric focus:outline-none focus:ring-2 focus:ring-[#0071e3]/25 focus:border-[#0071e3]"
                        aria-label="인증번호"
                      />
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={() => {
                            phoneConfirmationResultRef.current = null;
                            setPhoneStep("idle");
                            setPhoneCodeInput("");
                            setPhoneError("");
                          }}
                          className="flex-1 py-2.5 rounded-xl text-sm font-medium text-slate-600 bg-slate-100 hover:bg-slate-200 transition-colors btn-tap"
                        >
                          취소
                        </button>
                        <button
                          type="button"
                          onClick={async () => {
                            const code = phoneCodeInput.trim();
                            if (code.length !== 6) {
                              setPhoneError("인증번호 6자리를 입력해 주세요.");
                              return;
                            }
                            const conf = phoneConfirmationResultRef.current;
                            if (!conf) {
                              setPhoneError("인증을 다시 시도해 주세요.");
                              return;
                            }
                            setPhoneError("");
                            setPhoneStep("sending");
                            try {
                              const { phoneNumber } = await confirmPhoneCode(conf, code);
                              const uid = getCurrentUserUid();
                              const nextInfo = { ...myInfo, phoneNumber, uid: uid ?? undefined };
                              setMyInfo(nextInfo);
                              saveMyInfo(nextInfo);
                              if (typeof window !== "undefined") {
                                sessionStorage.setItem(LOGIN_GATE_KEY, "1");
                                setLoginGatePassed(true);
                              }
                            } catch (e) {
                              const msg = e instanceof Error ? e.message : "인증에 실패했습니다.";
                              setPhoneError(msg);
                              setPhoneStep("code");
                            }
                          }}
                          className="flex-1 py-2.5 rounded-xl text-sm font-medium text-white bg-[#0071e3] hover:bg-[#0077ed] transition-colors btn-tap"
                        >
                          인증 완료
                        </button>
                      </div>
                    </>
                  )}
                  {phoneError && (
                    <p className="text-xs text-amber-600" role="alert">
                      {phoneError}
                    </p>
                  )}
                </div>
            )}

            {/* 이메일 로그인 */}
            {isEmailAuthAvailable() && (
              <div className="space-y-2">
                <p className="text-xs text-slate-600 font-medium">이메일로 로그인</p>
                <input
                  type="email"
                  value={emailInput}
                  onChange={(e) => { setEmailInput(e.target.value); setEmailError(""); }}
                  placeholder="이메일"
                  className="w-full px-3 py-2.5 rounded-xl border border-slate-200 bg-white text-sm focus:outline-none focus:ring-2 focus:ring-[#0071e3]/25 focus:border-[#0071e3]"
                  aria-label="이메일"
                  autoComplete="email"
                />
                <input
                  type="password"
                  value={passwordInput}
                  onChange={(e) => { setPasswordInput(e.target.value); setEmailError(""); }}
                  placeholder="비밀번호"
                  className="w-full px-3 py-2.5 rounded-xl border border-slate-200 bg-white text-sm focus:outline-none focus:ring-2 focus:ring-[#0071e3]/25 focus:border-[#0071e3]"
                  aria-label="비밀번호"
                  autoComplete="current-password"
                />
                <div className="flex gap-2">
                  <button
                    type="button"
                    disabled={emailLoading || !emailInput.trim() || !passwordInput}
                    onClick={async () => {
                      const email = emailInput.trim();
                      const password = passwordInput;
                      if (!email || !password) return;
                      setEmailError("");
                      setEmailLoading(true);
                      try {
                        await ensureFirebase();
                        const { email: signedEmail, needsVerification } = await signUpWithEmail(email, password);
                        const uid = getCurrentUserUid();
                        const nextInfo = { ...myInfo, email: signedEmail, uid: uid ?? undefined };
                        setMyInfo(nextInfo);
                        saveMyInfo(nextInfo);
                        if (!needsVerification && typeof window !== "undefined") {
                          sessionStorage.setItem(LOGIN_GATE_KEY, "1");
                          setLoginGatePassed(true);
                        }
                        setEmailInput("");
                        setPasswordInput("");
                      } catch (e: unknown) {
                        const code = e && typeof e === "object" && "code" in e ? (e as { code: string }).code : "";
                        const msg =
                          code === "auth/email-already-in-use"
                            ? "이미 가입된 이메일입니다. 로그인을 사용하세요."
                            : code === "auth/weak-password"
                              ? "비밀번호는 6자 이상이어야 합니다."
                              : code === "auth/invalid-email"
                                ? "올바른 이메일 형식이 아닙니다."
                                : e instanceof Error ? e.message : "가입에 실패했습니다.";
                        setEmailError(msg);
                      } finally {
                        setEmailLoading(false);
                      }
                    }}
                    className="flex-1 py-2.5 rounded-xl text-sm font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 disabled:opacity-50 disabled:cursor-not-allowed transition-colors btn-tap"
                  >
                    가입
                  </button>
                  <button
                    type="button"
                    disabled={emailLoading || !emailInput.trim() || !passwordInput}
                    onClick={async () => {
                      const email = emailInput.trim();
                      const password = passwordInput;
                      if (!email || !password) return;
                      setEmailError("");
                      setEmailLoading(true);
                      try {
                        await ensureFirebase();
                        const { email: signedEmail, emailVerified } = await signInWithEmailAuth(email, password);
                        const uid = getCurrentUserUid();
                        const nextInfo = { ...myInfo, email: signedEmail, uid: uid ?? undefined };
                        setMyInfo(nextInfo);
                        saveMyInfo(nextInfo);
                        if (emailVerified && typeof window !== "undefined") {
                          sessionStorage.setItem(LOGIN_GATE_KEY, "1");
                          setLoginGatePassed(true);
                        }
                      } catch (e: unknown) {
                        const code = e && typeof e === "object" && "code" in e ? (e as { code: string }).code : "";
                        const msg =
                          code === "auth/invalid-credential" || code === "auth/user-not-found" || code === "auth/wrong-password"
                            ? "이메일 또는 비밀번호가 맞지 않습니다."
                            : code === "auth/invalid-email"
                              ? "올바른 이메일 형식이 아닙니다."
                              : e instanceof Error ? e.message : "로그인에 실패했습니다.";
                        setEmailError(msg);
                      } finally {
                        setEmailLoading(false);
                      }
                    }}
                    className="flex-1 py-2.5 rounded-xl text-sm font-medium text-white bg-[#0071e3] hover:bg-[#0077ed] disabled:opacity-50 disabled:cursor-not-allowed transition-colors btn-tap"
                  >
                    로그인
                  </button>
                </div>
                {emailError && (
                  <p className="text-xs text-amber-600" role="alert">
                    {emailError}
                  </p>
                )}
              </div>
            )}

            <p className="text-center pt-4">
              <a
                href="/privacy.html"
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-slate-500 underline hover:text-slate-700"
              >
                개인정보 처리방침
              </a>
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#f5f5f7] text-[#1d1d1f] max-w-md mx-auto flex flex-col">
      {/* 헤더 - Apple 스타일: 블러, 미니멀 */}
      <header className="sticky top-0 z-20 bg-white/80 backdrop-blur-xl border-b border-[#e8e8ed] safe-area-pb">
        <div className="flex items-center gap-3 px-3 py-4">
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
          <div
            className="fixed left-1/2 top-1/2 z-40 w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-2xl bg-white p-4 shadow-xl border border-[#e8e8ed]"
            onTouchStart={(e) => { overlayTouchStartRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY }; }}
            onTouchEnd={(e) => {
              const dy = e.changedTouches[0].clientY - overlayTouchStartRef.current.y;
              const dx = e.changedTouches[0].clientX - overlayTouchStartRef.current.x;
              if (dy > 50 && Math.abs(dy) > Math.abs(dx)) setShowGameModeHelp(false);
            }}
          >
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
          <div
            className="fixed left-1/2 top-1/2 z-40 w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-2xl bg-white p-4 shadow-xl border border-[#e8e8ed]"
            onTouchStart={(e) => { overlayTouchStartRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY }; }}
            onTouchEnd={(e) => {
              const dy = e.changedTouches[0].clientY - overlayTouchStartRef.current.y;
              const dx = e.changedTouches[0].clientX - overlayTouchStartRef.current.x;
              if (dy > 50 && Math.abs(dy) > Math.abs(dx)) setShowRecordHelp(false);
            }}
          >
            <p className="text-sm text-slate-700 leading-relaxed">
              선택한 경기 방식이 경기 목록에 추가됩니다. 원하는 경기를 누르면 상세가 열려 편집할 수 있습니다. 공유 링크를 참가자에게 전달하면, 받은 사람은 경기 명단에 신청(참가자 추가)하고 경기 현황에서 경기 결과를 함께 입력할 수 있습니다.
            </p>
            <p className="mt-2 text-xs text-slate-500 leading-relaxed">
              Firebase보다 많이 보이면 이 기기에만 있는 경기(로컬 전용)입니다. 경기 목록에서 위로 당겨 새로고침하면 서버 목록으로 맞춰지고, 서버에 없는 항목은 목록에서만 사라집니다.
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

      <main className="flex-1 min-h-0 flex flex-col px-2 pb-24 overflow-hidden scroll-smooth">
        <div
          ref={carouselViewportRef}
          className="flex-1 min-h-0 flex flex-col overflow-hidden"
          style={{ touchAction: "pan-y" }}
        >
          {/* 현재 탭 패널만 렌더 → iOS 등에서 상하 스크롤 정상 동작 */}
          <div className="flex-1 min-h-0 overflow-hidden w-full">
            {navIndex === 0 && (
            <div className="w-full h-full flex flex-col min-h-0">
              <div
                ref={(el) => { panelScrollRefs.current[0] = el; }}
                className="flex-1 min-h-0 overflow-x-hidden overscroll-contain pl-2 pr-2"
                style={{ overflowY: "auto", WebkitOverflowScrolling: "touch", touchAction: "pan-y" }}
              >
        <div key="setting" className="space-y-2 pt-4 animate-panel-enter">
        {/* 경기 방식: 카테고리 탭 + 좌측 목록 + 우측 상세 (참고 이미지 구조) */}
        <section id="section-info" className="scroll-mt-2">
          <div className="rounded-2xl bg-white shadow-[0_1px_3px_rgba(0,0,0,0.06)] border border-[#e8e8ed] overflow-hidden min-w-0 card-app card-app-interactive">
            {/* 상단 카테고리 탭 - 좁은 폭에서 크기 자동 보정, 균등 분배 */}
            <div className="flex border-b border-[#e8e8ed] flex-nowrap min-w-0">
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
                    className={`flex-1 min-w-0 px-1.5 py-2 sm:px-2.5 sm:py-2 text-[clamp(0.8125rem,2.2vw,1.125rem)] font-medium border-b-2 transition-colors flex items-center justify-center gap-1 sm:gap-2 ${isActive ? "border-[#0071e3] text-[#0071e3]" : "border-transparent text-slate-600 hover:text-slate-800"}`}
                  >
                    {cat.Icon && (
                      <span className="shrink-0 w-[clamp(1.25rem,6vw,2rem)] h-[clamp(1.25rem,6vw,2rem)] flex items-center justify-center">
                        <cat.Icon size="responsive" className="w-full h-full" />
                      </span>
                    )}
                    <span className="truncate">{cat.label}</span>
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
                            <table className="w-full min-w-[240px] table-auto border-collapse text-xs text-slate-600 leading-tight font-numeric">
                              <colgroup>
                                <col className="min-w-0" />
                                <col className="min-w-0" />
                                <col className="min-w-0" />
                                <col className="min-w-0" />
                                <col style={{ minWidth: "4.5rem" }} />
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
              </div>
            </div>
            )}
            {navIndex === 1 && (
            <div className="w-full h-full flex flex-col min-h-0 overflow-hidden">
              <div
                id="record-list-scroll"
                ref={(el) => { panelScrollRefs.current[1] = el; }}
                className="flex-1 min-h-0 overflow-x-hidden overflow-y-auto overscroll-contain pl-2 pr-2 relative"
                style={{ WebkitOverflowScrolling: "touch", touchAction: "pan-y" }}
              >
        <div key="record-wrap" className="relative pt-4 pb-28 min-h-[70vh] w-full animate-panel-enter">
        {!selectedGameId && (
        <div key="record-list" className="space-y-0.5 animate-fade-in-up">
          {(() => {
            void listRefreshKey;
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
                const staggerClass = ["animate-stagger-1", "animate-stagger-2", "animate-stagger-3", "animate-stagger-4", "animate-stagger-5", "animate-stagger-6", "animate-stagger-7", "animate-stagger-8", "animate-stagger-9", "animate-stagger-10", "animate-stagger-11", "animate-stagger-12"][index % 12];
                return (
                  <li key={id} className={`relative animate-fade-in-up ${staggerClass}`}>
                    {isNewest && (
                      <span className="absolute left-0 top-0 z-10" style={{ width: 18, height: 18 }}>
                        <span className="absolute left-0 top-0 block" style={{ width: 0, height: 0, borderStyle: "solid", borderWidth: "18px 18px 0 0", borderColor: "#f59e0b transparent transparent transparent" }} />
                        <span className="absolute left-[2px] top-0 text-[9px] font-bold text-white leading-none drop-shadow-[0_0_1px_rgba(0,0,0,0.5)]">
                          N
                        </span>
                      </span>
                    )}
                    <div
                      role="button"
                      tabIndex={0}
                      onClick={() => { setListMenuOpenId(null); setSelectedGameId(id); }}
                      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setListMenuOpenId(null); setSelectedGameId(id); } }}
                      style={{ touchAction: "pan-y" }}
                      className="w-full text-left px-2.5 py-1.5 pr-8 rounded-lg bg-white border border-[#e8e8ed] shadow-[0_1px_2px_rgba(0,0,0,0.05)] hover:bg-slate-50 hover:shadow-[0_2px_8px_rgba(0,0,0,0.06)] transition-all duration-200 btn-tap cursor-pointer card-app-interactive"
                    >
                      {/* 1행: 경기 이름 (공간 확보, 비어 있으면 빈 줄 유지) */}
                      <p className="font-semibold text-slate-800 truncate text-sm leading-tight font-numeric min-h-[1.25rem]" title={titleLabel}>{titleLabel || "\u00A0"}</p>
                      {/* 경기 요약 축약: 방식·인원·언제·어디·승점 + 만든이, 그 하단에 뱃지·테이블 */}
                      <div className="mt-0 space-y-px w-full block">
                        <p className="text-fluid-sm text-slate-500 leading-tight">경기 방식: {modeLabel}</p>
                          <p className="text-fluid-sm text-slate-500 leading-tight font-numeric">
                            경기 인원:{" "}
                            {mode && data.members.length >= mode.minPlayers && data.members.length <= mode.maxPlayers ? (
                              (() => {
                                const targetTotal = getTargetTotalGames(data.members.length);
                                const perPerson = targetTotal > 0 ? Math.round((targetTotal * 4) / data.members.length) : "-";
                                return <>총{data.members.length}명-총{targetTotal}경기-인당{perPerson}경기</>;
                              })()
                            ) : (
                              <>총{data.members.length}명-총-경기-인당-경기</>
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
                    </div>
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

        {selectedGameId && (
        <div
          key="record-detail"
          className="absolute inset-0 pt-4 bg-[var(--background)]"
          style={{
            overflowY: "auto",
            WebkitOverflowScrolling: "touch",
            touchAction: "pan-y",
            animation: recordDetailClosing
              ? "slideOutToLeftOverlay 0.25s cubic-bezier(0.32, 0.72, 0, 1) forwards"
              : "slideInFromLeftOverlay 0.3s cubic-bezier(0.32, 0.72, 0, 1) forwards",
          }}
          onTouchStart={(e) => e.stopPropagation()}
        >
        <div className="space-y-4 pb-8">
        {/* 선택한 경기: 경기 요약·명단·대진·현황·랭킹 */}
          <div className="flex items-center justify-between gap-2 pb-2">
            <button
              type="button"
              onClick={async () => {
                if (recordDetailClosing || effectiveGameId === null) return;
                /* 디바운스 대기 중인 저장 취소 후, DOM에서 경기 요약 최신값을 읽어 즉시 저장(편집 내용 유실 방지) */
                if (saveDebounceTimerRef.current) {
                  clearTimeout(saveDebounceTimerRef.current);
                  saveDebounceTimerRef.current = null;
                }
                saveDebounceRef.current = null;
                if (saveResultFirestoreTimerRef.current) {
                  clearTimeout(saveResultFirestoreTimerRef.current);
                  saveResultFirestoreTimerRef.current = null;
                }
                /* 저장 버튼 연타 시 state가 아직 반영 전일 수 있으므로, 로컬에 마지막 저장된 데이터(loadGame) 기준으로 payload 구성 */
                const existing = loadGame(effectiveGameId);
                const gameNameEl = document.getElementById("game-name") as HTMLInputElement | null;
                const gameDateEl = document.getElementById("game-date") as HTMLInputElement | null;
                const gameTimeEl = document.getElementById("game-time") as HTMLSelectElement | null;
                const gameLocationEl = document.getElementById("game-location") as HTMLInputElement | null;
                const gameScoreLimitEl = document.getElementById("game-score-limit") as HTMLInputElement | null;
                const gameNameToSave = gameNameEl?.value?.trim() || undefined;
                const dateToSave = gameDateEl?.value?.trim() || gameSettings.date;
                const timeToSave = (gameTimeEl?.value && TIME_OPTIONS_30MIN.includes(gameTimeEl.value)) ? gameTimeEl.value : gameSettings.time;
                const locationToSave = gameLocationEl?.value?.trim() ?? gameSettings.location;
                const scoreRaw = gameScoreLimitEl?.value != null ? parseInt(gameScoreLimitEl.value, 10) : gameSettings.scoreLimit;
                const scoreLimitToSave = Number.isNaN(scoreRaw) ? 21 : Math.max(1, Math.min(99, scoreRaw));
                const membersToSave =
                  myProfileMemberId != null && Array.isArray(existing.members)
                    ? existing.members.map((m: Member) =>
                        m.id === myProfileMemberId
                          ? { ...m, name: myInfo.name, gender: myInfo.gender, grade: myInfo.grade ?? "D" }
                          : m
                      )
                    : existing.members ?? [];
                const payload: GameData = {
                  members: membersToSave,
                  matches: existing.matches ?? [],
                  gameName: gameNameToSave,
                  gameMode: existing.gameMode ?? gameModeId,
                  gameSettings: { ...(existing.gameSettings ?? gameSettings), date: dateToSave, time: timeToSave, location: locationToSave, scoreLimit: scoreLimitToSave },
                  myProfileMemberId: existing.myProfileMemberId ?? myProfileMemberId ?? undefined,
                  createdAt: existing.createdAt ?? undefined,
                  createdBy: existing.createdBy ?? undefined,
                  createdByName: existing.createdByName ?? undefined,
                  createdByUid: existing.createdByUid ?? undefined,
                  playingMatchIds: existing.playingMatchIds ?? selectedPlayingMatchIds,
                  importedFromShare: existing.importedFromShare ?? undefined,
                  shareId: existing.shareId ?? undefined,
                };
                saveGame(effectiveGameId, payload);
                if (payload.shareId && isSyncAvailable()) {
                  try {
                    const ok = await setSharedGame(payload.shareId, payload);
                    if (ok) setLastFirestoreUploadBytes(getFirestorePayloadSize(payload));
                  } catch (_) {}
                }
                setRecordDetailClosing(true);
                setTimeout(() => {
                  setSelectedGameId(null);
                  setRecordDetailClosing(false);
                }, 250);
              }}
              disabled={recordDetailClosing}
              className="text-sm font-medium text-[#0071e3] hover:underline disabled:opacity-70 disabled:pointer-events-none"
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
          <div className="rounded-2xl bg-white shadow-[0_1px_3px_rgba(0,0,0,0.06)] border border-[#e8e8ed] overflow-hidden mt-2 card-app card-app-interactive">
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
                  onFocus={() => { gameSummaryFocusedRef.current = true; }}
                  onBlur={() => { gameSummaryFocusedRef.current = false; }}
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
                  {members.length >= gameMode.minPlayers && members.length <= gameMode.maxPlayers ? (
                    <>총{members.length}명-총{getTargetTotalGames(members.length)}경기-인당{getTargetTotalGames(members.length) > 0 ? Math.round((getTargetTotalGames(members.length) * 4) / members.length) : "-"}경기</>
                  ) : (
                    <>총{members.length}명-총-경기-인당-경기</>
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
                  onFocus={() => { gameSummaryFocusedRef.current = true; }}
                  onBlur={() => { gameSummaryFocusedRef.current = false; }}
                  className="flex-1 min-w-0 px-2 py-0.5 rounded-lg border border-[#d2d2d7] bg-[#fbfbfd] text-[#1d1d1f] text-sm focus:outline-none focus:ring-2 focus:ring-[#0071e3]/25 focus:border-[#0071e3] focus:border-blue-400"
                  aria-label="날짜"
                />
                <select
                  id="game-time"
                  value={TIME_OPTIONS_30MIN.includes(gameSettings.time) ? gameSettings.time : TIME_OPTIONS_30MIN[0]}
                  onChange={(e) => setGameSettings((s) => ({ ...s, time: e.target.value }))}
                  onFocus={() => { gameSummaryFocusedRef.current = true; }}
                  onBlur={() => { gameSummaryFocusedRef.current = false; }}
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
                  onFocus={() => { gameSummaryFocusedRef.current = true; }}
                  onBlur={() => { gameSummaryFocusedRef.current = false; }}
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
                  onFocus={() => { gameSummaryFocusedRef.current = true; }}
                  onBlur={() => { gameSummaryFocusedRef.current = false; }}
                  placeholder="21"
                  className="flex-1 min-w-0 w-20 px-2 py-0.5 rounded-lg border border-[#d2d2d7] bg-[#fbfbfd] text-[#1d1d1f] text-sm focus:outline-none focus:ring-2 focus:ring-[#0071e3]/25 focus:border-[#0071e3] focus:border-blue-400 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                  aria-label="한 경기당 득점 제한 (직접 입력)"
                />
                <span className="text-xs text-slate-500 shrink-0">점</span>
              </div>
            </div>
          </div>

          {/* 경기 명단 카드 - 报名名单 스타일 */}
          <div id="section-members" className="rounded-2xl bg-white shadow-[0_1px_3px_rgba(0,0,0,0.06)] border border-[#e8e8ed] overflow-hidden mt-2 scroll-mt-2 card-app card-app-interactive">
            <div className="px-2 py-1.5 border-b border-[#e8e8ed] flex items-center justify-between">
              <div>
                <h3 className="text-base font-semibold text-slate-800">경기 명단</h3>
                <p className="text-xs text-slate-500 mt-0.5">아래에서 경기 인원을 추가·삭제할 수 있습니다. <span className="inline-block" style={{ filter: "grayscale(1) brightness(0.9) contrast(1.1)" }}>🔃</span>=연동(Firebase 계정) · <span className="inline-block" style={{ filter: "grayscale(1) brightness(0.9) contrast(1.1)" }}>⏸️</span>=비연동</p>
              </div>
              <span className="shrink-0 px-1.5 py-0.5 rounded-full text-xs font-medium bg-slate-100 text-slate-600 border border-slate-200">
                {members.length}명
              </span>
            </div>
            <div className="w-full overflow-x-auto">
              <table className="w-full border-collapse border border-slate-300 text-left">
                <thead>
                  <tr className="bg-slate-100">
                    <th className="border-l border-slate-300 first:border-l-0 px-1 py-0 text-xs font-semibold text-slate-700 w-10">번호</th>
                    <th className="border-l border-slate-300 px-1 py-0 text-xs font-semibold text-slate-700 min-w-[6rem] w-32">프로필</th>
                    <th className="border-l border-slate-300 px-1 py-0 text-xs font-semibold text-slate-700 min-w-[3rem] w-14">삭제</th>
                  </tr>
                </thead>
                <tbody>
                  {members.map((m, i) => (
                    <tr key={m.id} className="bg-slate-50 even:bg-white">
                      <td className="border-l border-slate-300 first:border-l-0 px-1 py-0 align-middle">
                        <span className="inline-block text-sm leading-tight">{String(i + 1).padStart(2, "0")}</span>
                      </td>
                      <td className="border-l border-slate-300 px-1 py-0 align-middle text-sm font-medium text-slate-800 whitespace-nowrap min-w-0 leading-tight">
                        <span className="tracking-tighter inline-flex items-center gap-0" style={{ letterSpacing: "-0.02em" }}>
                          {m.name}
                          <span className="shrink-0 inline-block w-[0.65em] overflow-visible align-middle" style={{ lineHeight: 0 }} title={m.linkedUid ? "Firebase 계정 연동 · 공동편집·통계 연동 가능" : "비연동"} aria-label={m.linkedUid ? "연동" : "비연동"}>
                            <span className="inline-block origin-left" style={{ transform: "scale(0.65)", transformOrigin: "left center", filter: "grayscale(1) brightness(0.9) contrast(1.1)" }}>{m.linkedUid ? "🔃" : "⏸️"}</span>
                          </span>
                          <span className="inline-flex items-center gap-0 text-base leading-none origin-left" style={{ letterSpacing: "-0.08em", color: m.gender === "F" ? "#e8a4bc" : "#7c9fd8", transform: "scale(0.5)", transformOrigin: "left center" }}>
                            <span className="inline-block">{m.gender === "F" ? "\u2640\uFE0F" : "\u2642\uFE0F"}</span>
                            <span className="inline-block leading-none align-middle text-black">{m.grade}</span>
                          </span>
                        </span>
                      </td>
                      <td className="border-l border-slate-300 px-1 py-0 align-middle">
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
                </tbody>
              </table>
            </div>
            <div className="border-t border-[#e8e8ed] px-2 py-2">
              <div className="flex flex-row items-center gap-2 flex-wrap">
                <span className="text-xs font-medium text-slate-600 shrink-0">인원 추가</span>
                <input
                  type="text"
                  value={newMemberName}
                  onChange={(e) => setNewMemberName(e.target.value)}
                  placeholder="이름"
                  aria-label="이름"
                  className="flex-1 min-w-[4rem] h-9 px-3 py-0 text-sm rounded-lg border border-[#d2d2d7] bg-[#fbfbfd] text-[#1d1d1f] placeholder:text-[#6e6e73] focus:outline-none focus:ring-2 focus:ring-[#0071e3]/25 focus:border-[#0071e3] box-border"
                />
                <select
                  value={newMemberGender}
                  onChange={(e) => setNewMemberGender(e.target.value as "M" | "F")}
                  aria-label="성별"
                  className="shrink-0 w-16 h-9 px-2 py-0 text-sm rounded-lg border border-[#d2d2d7] bg-[#fbfbfd] text-[#1d1d1f] focus:outline-none focus:ring-2 focus:ring-[#0071e3]/25 focus:border-[#0071e3]"
                >
                  <option value="M">남</option>
                  <option value="F">여</option>
                </select>
                <select
                  value={newMemberGrade}
                  onChange={(e) => setNewMemberGrade(e.target.value as Grade)}
                  aria-label="급수"
                  className="shrink-0 w-14 h-9 px-2 py-0 text-sm rounded-lg border border-[#d2d2d7] bg-[#fbfbfd] text-[#1d1d1f] focus:outline-none focus:ring-2 focus:ring-[#0071e3]/25 focus:border-[#0071e3]"
                >
                  <option value="A">A</option>
                  <option value="B">B</option>
                  <option value="C">C</option>
                  <option value="D">D</option>
                </select>
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
                  className="shrink-0 h-9 px-4 rounded-lg text-sm font-medium text-white bg-[#0071e3] hover:bg-[#0077ed] transition-colors btn-tap"
                >
                  추가
                </button>
              </div>
            </div>
            <div className="border-t border-[#e8e8ed] px-2 py-2">
              <button
                type="button"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  const name = myInfo.name?.trim();
                  if (!name) {
                    alert("경기 이사에서 프로필 이름을 먼저 입력해 주세요.");
                    return;
                  }
                  const uid = myInfo.uid ?? getCurrentUserUid();
                  if (uid && members.some((m) => m.linkedUid === uid)) {
                    alert("이미 명단에 있습니다.");
                    return;
                  }
                  if (!uid && members.some((m) => m.name === name)) {
                    alert("이미 명단에 있습니다.");
                    return;
                  }
                  if (members.length >= gameMode.maxPlayers) {
                    alert(`경기 인원은 최대 ${gameMode.maxPlayers}명까지입니다.`);
                    return;
                  }
                  addMemberAsMe(name, myInfo.gender ?? "M", myInfo.grade ?? "D");
                }}
                className="w-full py-2 rounded-xl text-sm font-medium text-[#0071e3] bg-[#0071e3]/10 hover:bg-[#0071e3]/20 transition-colors btn-tap mb-2"
              >
                프로필로 나 추가
              </button>
              <button
                type="button"
                disabled={members.length < gameMode.minPlayers || members.length > gameMode.maxPlayers || (matches.length > 0 && !rosterChangedSinceGenerate)}
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
                className="w-full py-3 rounded-xl font-semibold text-white transition-colors hover:opacity-95 bg-[#0071e3] hover:bg-[#0077ed] btn-tap disabled:opacity-50 disabled:pointer-events-none disabled:cursor-not-allowed"
              >
                경기 생성
              </button>
              <p className="text-xs text-slate-500 mt-1.5">
                <span className="font-numeric">총{members.length}명-총{members.length >= gameMode.minPlayers ? getTargetTotalGames(members.length) : "-"}경기-인당{members.length >= gameMode.minPlayers && getTargetTotalGames(members.length) > 0 ? Math.round((getTargetTotalGames(members.length) * 4) / members.length) : "-"}경기</span>
              </p>
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
            <div className="rounded-2xl bg-white shadow-[0_1px_3px_rgba(0,0,0,0.06)] border border-[#e8e8ed] overflow-hidden mt-2 card-app card-app-interactive">
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
                      <span className="font-numeric">총{memberCount}명-총{matches.length}경기-인당{perPerson}경기</span>
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
                  const isDone = m.score1 !== null && m.score2 !== null;
                  /** 진행 = 선택됐고 아직 미종료인 경기만 (종료된 경기는 항상 종료로 표시) */
                  const isCurrent = !isDone && playingMatchIdsSet.has(String(m.id));
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
                            className={`block w-full text-left text-sm leading-none truncate rounded px-0.5 -mx-0.5 font-medium text-slate-700 hover:bg-slate-100 ${highlightMemberId && !isHighlight ? "opacity-90" : ""}`}
                            title={isHighlight ? "클릭 시 하이라이트 해제" : `${p.name} 클릭 시 이 선수 경기만 하이라이트 (같은 줄 왼쪽=파트너, 오른쪽=상대)`}
                          >
                            <span className={`tracking-tighter inline-flex items-center gap-0 truncate text-sm ${isHighlight ? "bg-amber-400 text-amber-900 font-bold ring-1 ring-amber-500 rounded px-0.5" : ""}`} style={{ letterSpacing: "-0.02em" }}>
                              {p.name}
                              <span className="shrink-0 inline-block w-[0.65em] overflow-visible align-middle" style={{ lineHeight: 0 }} title={p.linkedUid ? "Firebase 계정 연동 · 공동편집·통계 연동 가능" : "비연동"} aria-label={p.linkedUid ? "연동" : "비연동"}>
                                <span className="inline-block origin-left" style={{ transform: "scale(0.65)", transformOrigin: "left center", filter: "grayscale(1) brightness(0.9) contrast(1.1)" }}>{p.linkedUid ? "🔃" : "⏸️"}</span>
                              </span>
                              <span className="inline-flex items-center gap-0 text-base leading-none origin-left" style={{ letterSpacing: "-0.08em", color: p.gender === "F" ? "#e8a4bc" : "#7c9fd8", transform: "scale(0.5)", transformOrigin: "left center" }}>
                                <span className="inline-block">{p.gender === "F" ? "\u2640\uFE0F" : "\u2642\uFE0F"}</span>
                                <span className="inline-block leading-none align-middle text-black">{p.grade}</span>
                              </span>
                            </span>
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
                            className={`block w-full text-right text-sm leading-none truncate rounded px-0.5 -mx-0.5 font-medium text-slate-700 hover:bg-slate-100 ${highlightMemberId && !isHighlight ? "opacity-90" : ""}`}
                            title={isHighlight ? "클릭 시 하이라이트 해제" : `${p.name} 클릭 시 이 선수 경기만 하이라이트 (같은 줄 왼쪽=파트너, 오른쪽=상대)`}
                          >
                            <span className={`tracking-tighter inline-flex items-center gap-0 truncate text-sm justify-end ${isHighlight ? "bg-amber-400 text-amber-900 font-bold ring-1 ring-amber-500 rounded px-0.5" : ""}`} style={{ letterSpacing: "-0.02em" }}>
                              {p.name}
                              <span className="shrink-0 inline-block w-[0.65em] overflow-visible align-middle" style={{ lineHeight: 0 }} title={p.linkedUid ? "Firebase 계정 연동 · 공동편집·통계 연동 가능" : "비연동"} aria-label={p.linkedUid ? "연동" : "비연동"}>
                                <span className="inline-block origin-left" style={{ transform: "scale(0.65)", transformOrigin: "left center", filter: "grayscale(1) brightness(0.9) contrast(1.1)" }}>{p.linkedUid ? "🔃" : "⏸️"}</span>
                              </span>
                              <span className="inline-flex items-center gap-0 text-base leading-none origin-left" style={{ letterSpacing: "-0.08em", color: p.gender === "F" ? "#e8a4bc" : "#7c9fd8", transform: "scale(0.5)", transformOrigin: "left center" }}>
                                <span className="inline-block">{p.gender === "F" ? "\u2640\uFE0F" : "\u2642\uFE0F"}</span>
                                <span className="inline-block leading-none align-middle text-black">{p.grade}</span>
                              </span>
                            </span>
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
          <div className="rounded-2xl bg-white shadow-[0_1px_3px_rgba(0,0,0,0.06)] border border-[#e8e8ed] overflow-hidden card-app card-app-interactive">
            <div className="px-2 py-1.5 border-b border-[#e8e8ed]">
              <h3 className="text-base font-semibold text-slate-800">경기 결과</h3>
              <p className="text-xs text-slate-500 mt-0.5">경기 현황에서 진행한 경기 점수로 산출됩니다. 승수·득실차·급수 순으로 정렬됩니다.</p>
            </div>
            {matches.length === 0 ? (
              <p className="px-2 py-4 text-sm text-slate-500 text-center">경기 명단으로 경기 생성 후, 경기 현황에서 점수를 입력하면 여기에 결과가 표시됩니다.</p>
            ) : (
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
                    <div className="flex-1 min-w-0 flex items-center gap-0 leading-tight">
                      <span className="tracking-tighter inline-flex items-center gap-0 font-medium text-slate-800 text-sm" style={{ letterSpacing: "-0.02em" }}>
                        {m.name}
                        <span className="shrink-0 inline-block w-[0.65em] overflow-visible align-middle" style={{ lineHeight: 0 }} title={m.linkedUid ? "Firebase 계정 연동 · 공동편집·통계 연동 가능" : "비연동"} aria-label={m.linkedUid ? "연동" : "비연동"}>
                          <span className="inline-block origin-left" style={{ transform: "scale(0.65)", transformOrigin: "left center", filter: "grayscale(1) brightness(0.9) contrast(1.1)" }}>{m.linkedUid ? "🔃" : "⏸️"}</span>
                        </span>
                        <span className="inline-flex items-center gap-0 text-base leading-none origin-left" style={{ letterSpacing: "-0.08em", color: m.gender === "F" ? "#e8a4bc" : "#7c9fd8", transform: "scale(0.5)", transformOrigin: "left center" }}>
                          <span className="inline-block">{m.gender === "F" ? "\u2640\uFE0F" : "\u2642\uFE0F"}</span>
                          <span className="inline-block leading-none align-middle text-black">{m.grade}</span>
                        </span>
                      </span>
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
            )}
          </div>
        </section>

        </div>
        </div>
        )}
        </div>
              </div>
            </div>
            )}
            {navIndex === 2 && (
            <div className="w-full h-full flex flex-col min-h-0 overflow-hidden">
              <div
                ref={(el) => { panelScrollRefs.current[2] = el; }}
                className="flex-1 min-h-0 overflow-x-hidden overscroll-contain pl-2 pr-2"
                style={{ overflowY: "auto", WebkitOverflowScrolling: "touch", touchAction: "pan-y" }}
              >
          <div key="myinfo" className="pt-4 space-y-2 animate-panel-enter">
            {/* 로그인 상태: 수단 명시 + 로그아웃 (로그아웃 시 로그인 화면으로 이동) */}
            {(isPhoneAuthAvailable() && getCurrentPhoneUser()) || (isEmailAuthAvailable() && getCurrentEmailUser()) ? (
              <div className="rounded-2xl bg-white shadow-[0_1px_3px_rgba(0,0,0,0.06)] border border-[#e8e8ed] overflow-hidden card-app card-app-interactive">
                <div className="px-3 py-3 space-y-3">
                  <p className="text-xs text-slate-500">
                    로그인 수단:{" "}
                    {[
                      isPhoneAuthAvailable() && getCurrentPhoneUser() &&
                        `전화번호 (${getCurrentPhoneUser()?.phoneNumber || ""})`,
                      isEmailAuthAvailable() && getCurrentEmailUser() &&
                        `이메일 (${getCurrentEmailUser()?.email || ""})`,
                    ]
                      .filter(Boolean)
                      .join(", ")}
                  </p>
                  <button
                    type="button"
                    onClick={async () => {
                      if (isPhoneAuthAvailable() && getCurrentPhoneUser()) await signOutPhone();
                      if (isEmailAuthAvailable() && getCurrentEmailUser()) await signOutEmail();
                      setMyInfo((prev) => {
                        const next = { ...prev, phoneNumber: undefined, email: undefined, uid: undefined };
                        saveMyInfo(next);
                        return next;
                      });
                      if (typeof window !== "undefined") {
                        sessionStorage.removeItem(LOGIN_GATE_KEY);
                        setLoginGatePassed(false);
                      }
                    }}
                    className="w-full px-4 py-2 rounded-lg text-sm font-medium bg-slate-100 text-slate-700 hover:bg-slate-200 transition-colors btn-tap"
                  >
                    로그아웃
                  </button>
                </div>
              </div>
            ) : null}

            {/* 프로필 = 이름 + 성별기호 + 급수기호. 나의 프로필 (로그인 시): 요약 + 프로필 수정 → 클릭 시 상세 폼 */}
            {(getCurrentPhoneUser() || getCurrentEmailUser()) && (
              <div className="rounded-2xl bg-white shadow-[0_1px_3px_rgba(0,0,0,0.06)] border border-[#e8e8ed] overflow-hidden card-app card-app-interactive">
                <div className="px-2.5 py-2 border-b border-[#e8e8ed]">
                  <h3 className="text-sm font-semibold text-slate-800">나의 프로필</h3>
                </div>
                <div className="px-2.5 py-2 space-y-2">
                  <div className="flex items-center gap-2 p-1.5 rounded-xl bg-slate-50 border border-slate-100">
                    <p className="min-w-0 flex-1 text-sm font-medium text-slate-800 truncate">
                      <span className="tracking-tighter inline-flex items-center gap-0" style={{ letterSpacing: "-0.02em" }}>
                        {myInfo.name || "이름 없음"}
                        <span className="shrink-0 inline-block w-[0.65em] overflow-visible align-middle" style={{ lineHeight: 0 }} title={myInfo.uid ? "Firebase 계정 연동 · 공동편집·통계 연동 가능" : "비연동"} aria-label={myInfo.uid ? "연동" : "비연동"}>
                          <span className="inline-block origin-left" style={{ transform: "scale(0.65)", transformOrigin: "left center", filter: "grayscale(1) brightness(0.9) contrast(1.1)" }}>{myInfo.uid ? "🔃" : "⏸️"}</span>
                        </span>
                        <span className="inline-flex items-center gap-0 text-base leading-none origin-left" style={{ letterSpacing: "-0.08em", color: myInfo.gender === "F" ? "#e8a4bc" : "#7c9fd8", transform: "scale(0.5)", transformOrigin: "left center" }}>
                          <span className="inline-block">{myInfo.gender === "F" ? "\u2640\uFE0F" : "\u2642\uFE0F"}</span>
                          <span className="inline-block leading-none align-middle text-black">{myInfo.grade ?? "D"}</span>
                        </span>
                      </span>
                    </p>
                    <button
                      type="button"
                      onClick={() => setProfileEditOpen(true)}
                      className="shrink-0 px-2.5 py-1 rounded-lg text-xs font-medium bg-[#0071e3] text-white hover:bg-[#0077ed] transition-colors btn-tap"
                    >
                      프로필 수정
                    </button>
                  </div>
                </div>
              </div>
            )}

            <div className="rounded-2xl bg-white shadow-[0_1px_3px_rgba(0,0,0,0.06)] border border-[#e8e8ed] overflow-hidden card-app card-app-interactive">
              <div className="px-2 py-2 space-y-4">
                <div>
                  <h3 className="text-sm font-semibold text-slate-700 mb-1.5">나의 전적</h3>
                  <hr className="border-t border-slate-200 my-2" aria-hidden />
                  <p className="text-slate-500 text-xs py-2">시스템을 준비중입니다.</p>
                </div>
              </div>
            </div>

            {/* 프로필 수정 (경기 이사 섹션 하위 창) */}
            {(profileEditOpen || profileEditClosing) && (
        <div
          className="fixed inset-0 z-30 bg-[var(--background)] flex flex-col max-w-md mx-auto left-0 right-0 min-h-dvh"
          style={{
            animation: profileEditClosing
              ? "slideOutToLeftOverlay 0.25s cubic-bezier(0.32, 0.72, 0, 1) forwards"
              : "slideInFromLeftOverlay 0.3s cubic-bezier(0.32, 0.72, 0, 1) forwards",
          }}
          aria-modal="true"
          onTouchStart={(e) => e.stopPropagation()}
        >
          <header className="flex items-center gap-2 shrink-0 px-3 py-2.5 border-b border-[#e8e8ed] bg-white">
            <button
              type="button"
              onClick={() => {
                if (profileEditClosing) return;
                setProfileEditClosing(true);
                setTimeout(() => {
                  setProfileEditOpen(false);
                  setProfileEditClosing(false);
                }, 250);
              }}
              disabled={profileEditClosing}
              className="flex items-center gap-1 px-2 py-1.5 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-100 transition-colors btn-tap disabled:opacity-70 disabled:pointer-events-none"
              aria-label="뒤로가기"
            >
              <span aria-hidden>←</span>
              <span>뒤로가기</span>
            </button>
            <h2 className="text-sm font-semibold text-slate-800 flex-1 text-center pr-12">프로필 수정</h2>
          </header>
          <div className="flex-1 min-h-0 overflow-y-auto scrollbar-hide-y px-2.5 py-3 space-y-2" data-scrollbar-hide style={{ scrollbarWidth: "none", msOverflowStyle: "none" }}>
            <div className="grid gap-1.5">
              <div className="flex items-center gap-1.5">
                <label className="text-xs font-medium text-slate-600 shrink-0 w-28">이름</label>
                <input
                  type="text"
                  value={myInfo.name}
                  onChange={(e) => {
                    const next = { ...myInfo, name: e.target.value };
                    setMyInfo(next);
                    saveMyInfo(next);
                  }}
                  placeholder="이름"
                  className="flex-1 min-w-0 px-2 py-1.5 rounded-lg border border-[#d2d2d7] bg-[#fbfbfd] text-[#1d1d1f] text-sm focus:outline-none focus:ring-2 focus:ring-[#0071e3]/25 focus:border-[#0071e3]"
                  aria-label="이름"
                />
              </div>
              <div className="flex items-center gap-1.5">
                <label className="text-xs font-medium text-slate-600 shrink-0 w-28">성별</label>
                <select
                  value={myInfo.gender}
                  onChange={(e) => {
                    const next = { ...myInfo, gender: e.target.value as "M" | "F" };
                    setMyInfo(next);
                    saveMyInfo(next);
                  }}
                  className="flex-1 min-w-0 px-2 py-1.5 rounded-lg border border-[#d2d2d7] bg-[#fbfbfd] text-sm focus:outline-none focus:ring-2 focus:ring-[#0071e3]/25"
                  aria-label="성별"
                >
                  <option value="M">남</option>
                  <option value="F">여</option>
                </select>
              </div>
              <div className="flex items-center gap-1.5">
                <label className="text-xs font-medium text-slate-600 shrink-0 w-28">급수</label>
                <select
                  value={myInfo.grade ?? "D"}
                  onChange={(e) => {
                    const next = { ...myInfo, grade: e.target.value as Grade };
                    setMyInfo(next);
                    saveMyInfo(next);
                  }}
                  className="flex-1 min-w-0 px-2 py-1.5 rounded-lg border border-[#d2d2d7] bg-[#fbfbfd] text-sm focus:outline-none focus:ring-2 focus:ring-[#0071e3]/25"
                  aria-label="급수"
                >
                  <option value="A">A</option>
                  <option value="B">B</option>
                  <option value="C">C</option>
                  <option value="D">D</option>
                </select>
              </div>
              <div className="flex items-center gap-1.5">
                <label className="text-xs font-medium text-slate-600 shrink-0 w-28">전화번호</label>
                <input
                  type="tel"
                  value={myInfo.phoneNumber ?? ""}
                  onChange={(e) => {
                    const next = { ...myInfo, phoneNumber: e.target.value.trim() || undefined };
                    setMyInfo(next);
                    saveMyInfo(next);
                  }}
                  placeholder="010-1234-5678"
                  className="flex-1 min-w-0 px-2 py-1.5 rounded-lg border border-[#d2d2d7] bg-[#fbfbfd] text-[#1d1d1f] text-sm focus:outline-none focus:ring-2 focus:ring-[#0071e3]/25 focus:border-[#0071e3]"
                  aria-label="전화번호"
                />
              </div>
              <div className="flex items-center gap-1.5">
                <label className="text-xs font-medium text-slate-600 shrink-0 w-28">생년월일</label>
                <input
                  type="date"
                  value={myInfo.birthDate ?? ""}
                  onChange={(e) => {
                    const next = { ...myInfo, birthDate: e.target.value || undefined };
                    setMyInfo(next);
                    saveMyInfo(next);
                  }}
                  className="flex-1 min-w-0 px-2 py-1.5 rounded-lg border border-[#d2d2d7] bg-[#fbfbfd] text-[#1d1d1f] text-sm focus:outline-none focus:ring-2 focus:ring-[#0071e3]/25 focus:border-[#0071e3]"
                  aria-label="생년월일"
                />
              </div>
              <div className="flex items-center gap-1.5 mt-2">
                <span className="shrink-0 w-28" />
                <button
                  type="button"
                  onClick={uploadProfileToFirestore}
                  className="shrink-0 px-3 py-1.5 rounded-lg text-sm font-medium bg-[#0071e3] text-white hover:bg-[#0077ed] transition-colors btn-tap whitespace-nowrap"
                >
                  업로드
                </button>
                <span className="text-xs text-slate-500">다른 기기에서 로그인 시 이 프로필이 적용됩니다.</span>
              </div>
              {loginMessage && (
                <p className="text-xs text-slate-600 mt-1 px-1">{loginMessage}</p>
              )}
            </div>
          </div>
        </div>
            )}
          </div>
          </div>
          </div>
            )}
          </div>
        </div>
      </main>

      {/* 하단 네비 - 블러·미니멀 (프로필 업로드 전에는 경기 방식·경기 목록 비활성) */}
      <nav className="fixed bottom-0 left-0 right-0 max-w-md mx-auto bg-white/90 backdrop-blur-xl border-t border-[#e8e8ed] flex justify-start gap-0 px-2 py-2 shadow-[0_-1px_0_0_rgba(0,0,0,0.06)]">
        <button
          type="button"
          onClick={() => {
            if (!isProfileComplete) {
              setNavView("myinfo");
              setShareToast("프로필을 입력한 뒤 업로드하면 이용할 수 있습니다.");
              setTimeout(() => setShareToast(null), 3000);
              return;
            }
            setNavView("setting");
          }}
          className={`flex flex-col items-center gap-0.5 py-2 px-4 min-w-0 rounded-xl nav-tab btn-tap ${!isProfileComplete ? "opacity-60 text-[#9ca3af]" : ""} ${navView === "setting" ? "bg-[#0071e3]/10 text-[#0071e3] font-semibold" : "text-[#6e6e73] hover:text-[#1d1d1f] hover:bg-black/5"}`}
        >
          <NavIconGameMode className="w-10 h-10 shrink-0" />
          <span className="text-sm font-medium leading-tight">경기 방식</span>
        </button>
        <button
          type="button"
          onClick={() => {
            if (!isProfileComplete) {
              setNavView("myinfo");
              setShareToast("프로필을 입력한 뒤 업로드하면 이용할 수 있습니다.");
              setTimeout(() => setShareToast(null), 3000);
              return;
            }
            setNavView("record");
            setSelectedGameId(null);
          }}
          className={`flex flex-col items-center gap-0.5 py-2 px-4 min-w-0 rounded-xl nav-tab btn-tap ${!isProfileComplete ? "opacity-60 text-[#9ca3af]" : ""} ${navView === "record" ? "bg-[#0071e3]/10 text-[#0071e3] font-semibold" : "text-[#6e6e73] hover:text-[#1d1d1f] hover:bg-black/5"}`}
        >
          <NavIconGameList className="w-10 h-10 shrink-0" />
          <span className="text-sm font-medium leading-tight">경기 목록</span>
        </button>
        <button
          type="button"
          onClick={() => setNavView("myinfo")}
          className={`relative flex flex-col items-center gap-0.5 py-2 px-4 min-w-0 rounded-xl nav-tab btn-tap ${navView === "myinfo" ? "bg-[#0071e3]/10 text-[#0071e3] font-semibold" : "text-[#6e6e73] hover:text-[#1d1d1f] hover:bg-black/5"}`}
        >
          <NavIconMyInfo className="w-10 h-10 shrink-0" filled={isProfileComplete} />
          <span className="text-sm font-medium leading-tight">경기 이사</span>
        </button>
      </nav>

      {/* 경기 생성 전 확인 모달 */}
      {shareToast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40 px-4 py-2 rounded-lg bg-slate-800 text-white text-sm shadow-lg animate-scale-in" role="status">
          {shareToast}
        </div>
      )}
      {showRegenerateConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 animate-fade-in" aria-modal="true" role="alertdialog" aria-labelledby="regenerate-confirm-title">
          <div
            className="bg-white rounded-2xl shadow-xl max-w-sm w-full p-4 space-y-3 animate-scale-in"
            onTouchStart={(e) => { overlayTouchStartRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY }; }}
            onTouchEnd={(e) => {
              const dy = e.changedTouches[0].clientY - overlayTouchStartRef.current.y;
              const dx = e.changedTouches[0].clientX - overlayTouchStartRef.current.x;
              if (dy > 50 && Math.abs(dy) > Math.abs(dx)) setShowRegenerateConfirm(false);
            }}
          >
            <p id="regenerate-confirm-title" className="text-sm text-slate-700 leading-relaxed">
              현재 진행중인 경기 현황을 초기화가 됩니다. 진행하시겠습니까?
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
  return (
    <Suspense fallback={<div className="min-h-screen flex items-center justify-center text-slate-500 text-sm">로딩 중...</div>}>
      <GameView gameId={null} />
    </Suspense>
  );
}
