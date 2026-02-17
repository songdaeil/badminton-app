"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { addGameToList, createGameId, DEFAULT_GAME_SETTINGS, DEFAULT_MYINFO, loadGame, loadGameList, loadMyInfo, removeGameFromList, saveGame, saveMyInfo } from "@/lib/game-storage";
import { getKakaoJsKey, initKakao, loginWithKakao, logoutKakao } from "@/lib/kakao";
import type { GameSettings, MyInfo } from "@/lib/game-storage";
import type { GameMode, Grade, Member, Match } from "./types";

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

/** 경기 방식 목록. 선택한 방식이 경기 설정(한 경기당 몇 점 등)에 반영됨 */
const GAME_MODES: GameMode[] = [
  {
    id: "individual",
    label: "개인전 (4~12명)",
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
  const [members, setMembers] = useState<Member[]>([]);
  const [matches, setMatches] = useState<Match[]>([]);
  const [scoreInputs, setScoreInputs] = useState<Record<string, { s1: string; s2: string }>>({});
  const [mounted, setMounted] = useState(false);
  /** 사용자 정의 경기 이름 (경기 목록 메인 표기) */
  const [gameName, setGameName] = useState<string>("");
  /** 선택된 경기 방식 id (저장·로드 반영) */
  const [gameModeId, setGameModeId] = useState<string>(GAME_MODES[0].id);
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
  /** 테이블 내 직접입력 행: 새 참가자 입력값 */
  const [newMemberName, setNewMemberName] = useState("");
  const [newMemberGender, setNewMemberGender] = useState<"M" | "F">("M");
  const [newMemberGrade, setNewMemberGrade] = useState<Grade>("B");

  const effectiveGameId = gameId ?? selectedGameId;
  const gameMode = GAME_MODES.find((m) => m.id === gameModeId) ?? GAME_MODES[0];

  useEffect(() => {
    if (effectiveGameId === null) {
      setMembers([]);
      setMatches([]);
      setGameName("");
      setGameModeId(GAME_MODES[0].id);
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
    setGameName(typeof data.gameName === "string" ? data.gameName : "");
    setMatches(data.matches);
    setMyProfileMemberId(
      data.myProfileMemberId ?? data.members.find((m) => m.name === "송대일")?.id ?? null
    );
    const loadedModeId = data.gameMode && GAME_MODES.some((m) => m.id === data.gameMode) ? data.gameMode! : GAME_MODES[0].id;
    setGameModeId(loadedModeId);
    const loadedMode = GAME_MODES.find((m) => m.id === loadedModeId) ?? GAME_MODES[0];
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
    saveGame(effectiveGameId, {
      members: membersToSave,
      matches,
      gameName: gameName || undefined,
      gameMode: gameModeId,
      gameSettings,
      myProfileMemberId: myProfileMemberId ?? undefined,
      createdAt: existing.createdAt ?? undefined,
      createdBy: existing.createdBy ?? undefined,
      createdByName: existing.createdByName ?? undefined,
      playingMatchIds: selectedPlayingMatchIds,
    });
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
    setSelectedGameId(id);
    setNavView("record");
  }, [gameModeId, myProfileMemberId, members, myInfo.name]);

  const handleShareGame = useCallback(() => {
    if (effectiveGameId === null) return;
    const id = createGameId();
    const existing = loadGame(effectiveGameId);
    saveGame(id, {
      members,
      matches,
      gameName: gameName || undefined,
      gameMode: gameModeId,
      gameSettings,
      myProfileMemberId: myProfileMemberId ?? undefined,
      createdAt: existing.createdAt ?? undefined,
      createdBy: existing.createdBy ?? undefined,
      createdByName: existing.createdByName ?? undefined,
    });
    router.push(`/game/${id}`);
  }, [effectiveGameId, members, matches, gameName, gameModeId, gameSettings, myProfileMemberId, router]);

  /** 목록 카드에서 해당 경기 삭제 */
  const handleDeleteCard = useCallback((gameId: string) => {
    removeGameFromList(gameId);
    if (selectedGameId === gameId) setSelectedGameId(null);
    setListMenuOpenId(null);
  }, [selectedGameId]);

  /** 목록 카드에서 해당 경기 복사해 신규 생성 (복사한 시점의 나를 만든 이로 저장) */
  const handleCopyCard = useCallback((gameId: string) => {
    const existing = loadGame(gameId);
    const newId = createGameId();
    const newMatches = (existing.matches ?? []).map((m) => ({
      ...m,
      id: createId(),
      team1: { ...m.team1, id: createId(), players: m.team1.players },
      team2: { ...m.team2, id: createId(), players: m.team2.players },
      savedAt: null,
      savedBy: null,
      savedHistory: [],
    }));
    saveGame(newId, {
      members: existing.members ?? [],
      matches: newMatches,
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
    setSelectedGameId(newId);
  }, [myInfo.name]);

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
          <h1 className="text-[1.25rem] font-semibold tracking-tight text-[#1d1d1f]">
            {navView === "setting" && "경기 방식"}
            {navView === "record" && "경기 목록"}
            {navView === "myinfo" && "경기 이사"}
          </h1>
        </div>
      </header>

      <main className="flex-1 px-2 pb-24 overflow-auto">
        {navView === "setting" && (
        <div className="space-y-2 pt-4">
        {/* 경기 방식만: 선정 후 목록에 추가 */}
        <section id="section-info" className="scroll-mt-2">
          <p className="text-sm text-slate-600 leading-snug mb-1.5">원하는 경기 방식을 경기 목록에 추가하여 경기 관리 및 배포 할 수 있습니다</p>
          <div className="rounded-2xl bg-white shadow-[0_1px_3px_rgba(0,0,0,0.06)] border border-[#e8e8ed] overflow-hidden">
            <div className="px-3 py-1.5 border-b border-[#e8e8ed]">
              <p className="text-xs text-slate-500 mb-2">보유 경기 방식 수 : <span className="font-numeric">{GAME_MODES.length}</span> 개</p>
              <div>
                <button
                  type="button"
                  onClick={addGameToRecord}
                  className="w-full py-1.5 rounded-xl font-semibold text-white bg-[#0071e3] hover:bg-[#0077ed] transition-colors"
                >
                  아래 경기 방식으로 경기 목록에 추가
                </button>
              </div>
            </div>
            <div className="px-3 py-2 text-fluid-base text-[#6e6e73] space-y-1 leading-relaxed">
              <div className="flex flex-wrap items-center gap-2 mb-2">
                <label htmlFor="game-mode" className="text-fluid-base text-[#6e6e73] shrink-0 py-0.5 leading-tight">경기 방식</label>
                <select
                  id="game-mode"
                  value={gameModeId}
                  onChange={(e) => {
                    const nextId = e.target.value;
                    setGameModeId(nextId);
                    const nextMode = GAME_MODES.find((m) => m.id === nextId) ?? GAME_MODES[0];
                    const defaultScore = nextMode.defaultScoreLimit ?? 21;
                    setGameSettings((prev) => ({
                      ...prev,
                      scoreLimit: prev.scoreLimit >= 1 && prev.scoreLimit <= 99 ? prev.scoreLimit : defaultScore,
                    }));
                  }}
                  className="text-sm font-semibold text-[#1d1d1f] px-3 py-1.5 rounded-xl border-2 border-[#0071e3]/30 bg-[#f5f5f7] focus:outline-none focus:ring-2 focus:ring-[#0071e3]/25 focus:border-[#0071e3]"
                  aria-label="경기 방식 선택"
                >
                  {GAME_MODES.map((mode) => (
                    <option key={mode.id} value={mode.id}>
                      {mode.label}
                    </option>
                  ))}
                </select>
              </div>
              <p className="font-medium text-slate-700 mb-0.5">경기 방식 설명</p>
              <div className="space-y-1 text-slate-600">
                <p className="leading-relaxed">
                  인원에 따라 총 경기 수와 인당 경기 수가 아래 표처럼 정해져 있으며, 참가자는 모두 동일한 경기 수로 공정하게 진행합니다.
                </p>
                <p className="leading-relaxed">
                  파트너와 상대를 경기마다 바꿔 가며 여러 분과 골고루 대전할 수 있습니다.
                </p>
              </div>
              <p className="font-medium text-slate-700 mt-2 mb-0.5">인원수 별 총 경기수 및 소요시간</p>
              <div className="overflow-x-auto mt-0.5">
                <table className="w-full table-fixed border-collapse text-xs text-slate-600 leading-tight font-numeric">
                  <colgroup>
                    <col style={{ width: "20%" }} />
                    <col style={{ width: "20%" }} />
                    <col style={{ width: "20%" }} />
                    <col style={{ width: "20%" }} />
                    <col style={{ width: "20%" }} />
                  </colgroup>
                  <thead>
                    <tr className="bg-slate-100">
                      <th className="border border-slate-200 px-2 py-0 text-center font-semibold text-slate-700">인원</th>
                      <th className="border border-slate-200 px-2 py-0 text-center font-semibold text-slate-700">총 경기수</th>
                      <th className="border border-slate-200 px-2 py-0 text-center font-semibold text-slate-700">인당 경기수</th>
                      <th className="border border-slate-200 px-2 py-0 text-center font-semibold text-slate-700">소요시간</th>
                      <th className="border border-slate-200 px-2 py-0 text-center font-semibold text-slate-700">필요코트</th>
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
                          <td className="border border-slate-200 px-2 py-0 text-center">{n}</td>
                          <td className="border border-slate-200 px-2 py-0 text-center">{total}</td>
                          <td className="border border-slate-200 px-2 py-0 text-center">{perPerson}</td>
                          <td className="border border-slate-200 px-2 py-0 text-center text-slate-600">{durationLabel}</td>
                          <td className="border border-slate-200 px-2 py-0 text-center text-slate-600">{courtLabel}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </section>
        </div>
        )}

        {navView === "record" && !selectedGameId && (
        /* 경기 목록: 경기 목록 */
        <div className="pt-4 space-y-0.5">
          <p className="text-sm text-slate-600 leading-snug mb-1.5">선택한 경기 방식이 여기 목록으로 추가됩니다. 항목을 누르면 설정·명단·대진을 할 수 있습니다.</p>
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
              {sortedIds.map((id) => {
                const data = loadGame(id);
                const mode = data.gameMode ? GAME_MODES.find((m) => m.id === data.gameMode) : null;
                const modeLabel = mode?.label ?? data.gameMode ?? "경기";
                const hasCustomName = typeof data.gameName === "string" && data.gameName.trim();
                const perPerson = data.members.length > 0 ? Math.round((data.matches.length * 4) / data.members.length) : 0;
                const defaultTitle = `${modeLabel} 총${data.members.length}명 총${data.matches.length}경기 인당${perPerson}경기`;
                const titleLabel = (hasCustomName ? data.gameName!.trim() : defaultTitle).replace(/_/g, " ");
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
                /** 참가신청: 종료 0개 & 진행 0개. 경기진행: 종료 또는 진행 1개 이상(전부 종료 전). 경기종료: 전부 종료 */
                const currentStage =
                  completedCount === 0 && ongoingCount === 0 ? "참가신청단계" : allDone ? "경기종료단계" : "경기진행단계";
                const stages = ["참가신청단계", "경기진행단계", "경기종료단계"] as const;
                /** 단계별 뱃지 하이라이트: 참가신청=초록, 경기진행=노랑, 경기종료=검정 */
                const stageHighlight: Record<(typeof stages)[number], string> = {
                  참가신청단계: "bg-green-100 text-green-700 border border-green-200",
                  경기진행단계: "bg-amber-100 text-amber-700 border border-amber-200",
                  경기종료단계: "bg-slate-800 text-white border border-slate-700",
                };
                /** 테이블 헤더도 현재 단계와 동일 색채로 매칭 */
                const tableHeaderByStage: Record<(typeof stages)[number], string> = {
                  참가신청단계: "bg-green-100 text-green-700",
                  경기진행단계: "bg-amber-100 text-amber-700",
                  경기종료단계: "bg-slate-800 text-white",
                };
                const stageMuted = "bg-slate-50 text-slate-400";
                const tableHeaderClass = tableHeaderByStage[currentStage];
                const total = data.matches.length;
                const waitingCount = total - completedCount - ongoingCount;
                const pct = (n: number) => (total ? Math.round((n / total) * 100) : 0);
                const isMenuOpen = listMenuOpenId === id;
                return (
                  <li key={id} className="relative">
                    <button
                      type="button"
                      onClick={() => { setListMenuOpenId(null); setSelectedGameId(id); }}
                      className="w-full text-left px-2.5 py-1.5 pr-8 rounded-lg bg-white border border-[#e8e8ed] shadow-[0_1px_2px_rgba(0,0,0,0.05)] hover:bg-slate-50 transition-colors"
                    >
                      {/* 1행: 경기 이름 한 줄 */}
                      <p className="font-semibold text-slate-800 truncate text-sm leading-tight font-numeric" title={titleLabel}>{titleLabel}</p>
                      {/* 가상의 세로선 기준: 좌측=만든이·날짜·경기방식, 우측=뱃지·테이블(여백 없이 붙임) */}
                      <div className="flex items-start gap-0.5 mt-0">
                        <div className="min-w-0 shrink-0 space-y-px">
                          <p className="text-fluid-sm text-slate-500 leading-tight">
                            만든 이: {creatorDisplay}{dateStr ? ` ${dateStr}` : ""}
                          </p>
                          <p className="text-fluid-sm text-slate-500 leading-tight font-numeric">
                            {data.members.length}명 · {data.matches.length}경기
                            {data.members.length > 0 && ` · 인당 ${Math.round((data.matches.length * 4) / data.members.length)}경기`}
                          </p>
                          <p className="text-fluid-sm text-slate-500 leading-tight">경기 방식: {modeLabel}</p>
                        </div>
                        <div className="shrink-0 flex flex-col gap-0.5">
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
                            <table className="w-max text-xs border border-slate-200 rounded overflow-hidden font-numeric">
                              <tbody>
                                <tr className={tableHeaderClass}>
                                  <th className="py-0 pl-1 pr-0.5 text-left font-medium leading-none">총경기수</th>
                                  <th className={`py-0 pl-1 pr-0.5 text-left font-medium border-l leading-none ${currentStage === "경기종료단계" ? "border-slate-600" : "border-slate-200"}`}>종료수</th>
                                  <th className={`py-0 pl-1 pr-0.5 text-left font-medium border-l leading-none ${currentStage === "경기종료단계" ? "border-slate-600" : "border-slate-200"}`}>진행수</th>
                                  <th className={`py-0 pl-1 pr-0.5 text-left font-medium border-l leading-none ${currentStage === "경기종료단계" ? "border-slate-600" : "border-slate-200"}`}>대기수</th>
                                </tr>
                                <tr className="border-t border-[#e8e8ed] bg-white text-slate-700">
                                  <td className="py-0 pl-1 pr-0.5 text-left font-medium leading-none">{total} <span className="text-slate-500 font-normal">({pct(total)}%)</span></td>
                                  <td className="py-0 pl-1 pr-0.5 text-left font-medium border-l border-slate-100 leading-none">{completedCount} <span className="text-slate-500 font-normal">({pct(completedCount)}%)</span></td>
                                  <td className="py-0 pl-1 pr-0.5 text-left font-medium border-l border-slate-100 leading-none">{ongoingCount} <span className="text-slate-500 font-normal">({pct(ongoingCount)}%)</span></td>
                                  <td className="py-0 pl-1 pr-0.5 text-left font-medium border-l border-slate-100 leading-none">{waitingCount} <span className="text-slate-500 font-normal">({pct(waitingCount)}%)</span></td>
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
                              className="w-full text-left px-2.5 py-1.5 text-xs text-red-600 hover:bg-red-50 rounded-t-lg"
                            >
                              삭제
                            </button>
                            <button
                              type="button"
                              onClick={(e) => { e.stopPropagation(); handleCopyCard(id); }}
                              className="w-full text-left px-2.5 py-1.5 text-xs text-slate-700 hover:bg-slate-50 rounded-b-lg"
                            >
                              복사
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
        <div className="space-y-4 pt-4">
        {/* 선택한 경기: 경기 설정·명단·대진·현황·랭킹 */}
          <div className="flex items-center justify-between gap-2 pb-2">
            <button
              type="button"
              onClick={() => setSelectedGameId(null)}
              className="text-sm font-medium text-[#0071e3] hover:underline"
            >
              ← 목록으로
            </button>
          </div>
          {/* 경기 설정 카드 */}
          <div className="rounded-2xl bg-white shadow-[0_1px_3px_rgba(0,0,0,0.06)] border border-[#e8e8ed] overflow-hidden mt-2">
            <div className="px-4 py-1 border-b border-[#e8e8ed]">
              <h3 className="text-base font-semibold text-slate-800 leading-tight">경기 설정</h3>
            </div>
            <div className="px-4 py-1 space-y-0.5">
              <div className="flex items-center gap-0.5">
                <label htmlFor="game-name" className="text-xs font-medium text-slate-600 shrink-0 w-16">경기 이름</label>
                <input
                  id="game-name"
                  type="text"
                  value={gameName}
                  onChange={(e) => setGameName(e.target.value)}
                  placeholder="경기 이름 입력"
                  className="flex-1 min-w-0 px-2 py-1 rounded-lg border border-[#d2d2d7] bg-[#fbfbfd] text-[#1d1d1f] placeholder:text-[#6e6e73] text-sm focus:outline-none focus:ring-2 focus:ring-[#0071e3]/25 focus:border-[#0071e3]"
                  aria-label="경기 이름"
                />
              </div>
              <div className="flex items-center gap-0.5">
                <span className="text-xs font-medium text-slate-600 shrink-0 w-16">경기 방식</span>
                <span className="flex-1 text-sm font-semibold text-[#0071e3] bg-[#0071e3]/10 px-2 py-1 rounded-lg border border-[#0071e3]/20">
                  {gameMode.label}
                </span>
              </div>
              <div className="flex items-center gap-0.5">
                <label htmlFor="game-date" className="text-xs font-medium text-slate-600 shrink-0 w-16">경기 언제</label>
                <input
                  id="game-date"
                  type="date"
                  value={gameSettings.date}
                  onChange={(e) => setGameSettings((s) => ({ ...s, date: e.target.value }))}
                  className="flex-1 min-w-0 px-2 py-1 rounded-lg border border-[#d2d2d7] bg-[#fbfbfd] text-[#1d1d1f] text-sm focus:outline-none focus:ring-2 focus:ring-[#0071e3]/25 focus:border-[#0071e3] focus:border-blue-400"
                  aria-label="날짜"
                />
                <select
                  value={TIME_OPTIONS_30MIN.includes(gameSettings.time) ? gameSettings.time : TIME_OPTIONS_30MIN[0]}
                  onChange={(e) => setGameSettings((s) => ({ ...s, time: e.target.value }))}
                  className="w-24 px-2 py-1 rounded-lg border border-[#d2d2d7] bg-[#fbfbfd] text-[#1d1d1f] text-sm focus:outline-none focus:ring-2 focus:ring-[#0071e3]/25 focus:border-[#0071e3] focus:border-blue-400"
                  aria-label="시작 시간 (30분 단위)"
                >
                  {TIME_OPTIONS_30MIN.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex items-center gap-0.5">
                <label htmlFor="game-location" className="text-xs font-medium text-slate-600 shrink-0 w-16">경기 어디</label>
                <input
                  id="game-location"
                  type="text"
                  value={gameSettings.location}
                  onChange={(e) => setGameSettings((s) => ({ ...s, location: e.target.value }))}
                  placeholder="장소 입력"
                  className="flex-1 min-w-0 px-2 py-1 rounded-lg border border-[#d2d2d7] bg-[#fbfbfd] text-[#1d1d1f] placeholder:text-[#6e6e73] text-sm focus:outline-none focus:ring-2 focus:ring-[#0071e3]/25 focus:border-[#0071e3]"
                  aria-label="장소"
                />
              </div>
              <div className="flex items-center gap-0.5">
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
                  className="flex-1 min-w-0 w-20 px-2 py-1 rounded-lg border border-[#d2d2d7] bg-[#fbfbfd] text-[#1d1d1f] text-sm focus:outline-none focus:ring-2 focus:ring-[#0071e3]/25 focus:border-[#0071e3] focus:border-blue-400 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
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
                          if (!trimmed) return;
                          if (members.length >= gameMode.maxPlayers) return;
                          addMember(trimmed, newMemberGender, newMemberGrade);
                          setNewMemberName("");
                        }}
                        disabled={members.length >= gameMode.maxPlayers}
                        className="h-6 min-w-[2.25rem] px-2 rounded text-xs font-medium text-white whitespace-nowrap hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed bg-[#0071e3] box-border"
                      >
                        추가
                      </button>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div className="border-t border-[#e8e8ed] px-2 py-2">
              <div>
                <p className="text-fluid-xs text-slate-400 mb-0.5">나를넣기</p>
                  <button
                    type="button"
                    onClick={() => {
                      const name = myInfo.name?.trim();
                      if (!name) return;
                      if (members.length >= gameMode.maxPlayers) return;
                      if (members.some((m) => m.name === name && m.gender === myInfo.gender && m.grade === myInfo.grade)) return;
                      addMember(name, myInfo.gender, myInfo.grade);
                    }}
                    disabled={!myInfo.name?.trim() || members.length >= gameMode.maxPlayers || members.some((m) => m.name === myInfo.name?.trim() && m.gender === myInfo.gender && m.grade === myInfo.grade)}
                    className="w-full py-1.5 px-3 rounded-lg font-medium text-sm border border-[#d2d2d7] bg-[#fbfbfd] text-slate-700 hover:bg-[#f0f0f2] disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    경기 이사로 참가자 추가
                  </button>
              </div>
            </div>
            <div className="border-t border-[#e8e8ed] px-2 py-2">
              <p className="text-xs text-slate-500 mb-0.5">로테이션 대진</p>
              <p className="text-xs text-slate-500 mb-1">
                현재 <span className="font-numeric">{members.length}</span>명 기준 목표 <strong className="text-slate-700 font-numeric">{members.length >= gameMode.minPlayers ? getTargetTotalGames(members.length) : "-"}</strong>경기
              </p>
              <button
                type="button"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  if (matches.length > 0) {
                    setShowRegenerateConfirm(true);
                    return;
                  }
                  doMatch();
                }}
                disabled={members.length < gameMode.minPlayers || members.length > gameMode.maxPlayers}
                className="w-full py-3 rounded-xl font-semibold text-white transition-colors hover:opacity-95 disabled:opacity-50 disabled:cursor-not-allowed bg-[#0071e3] hover:bg-[#0077ed]"
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
                  const perPerson =
                    members.length > 0 ? Math.round((matches.length * 4) / members.length) : 0;
                  return (
                    <p className="text-xs text-slate-500 mt-0.5">
                      오늘의 매치 · 총 <span className="font-numeric">{matches.length}</span>경기 · 인당 <span className="font-medium text-slate-700 font-numeric">{perPerson}</span>경기 (동일)
                    </p>
                  );
                })()}
              </div>
              <div className="px-2 py-1 border-b border-[#e8e8ed]">
                {/* 총경기수 / 종료수 / 진행수 / 대기수 테이블 */}
                {(() => {
                  const total = matches.length;
                  const completedCount = matches.filter((m) => m.score1 != null && m.score2 != null).length;
                  const ongoingCount = playingMatches.length;
                  const waitingCount = total - completedCount - ongoingCount;
                  const pct = (n: number) => (total ? Math.round((n / total) * 100) : 0);
                  return (
                    <table className="w-max max-w-full text-sm border border-slate-200 rounded overflow-hidden font-numeric">
                      <tbody className="bg-white text-slate-700">
                        <tr className="bg-slate-100 text-slate-600">
                          <th className="py-0.5 px-1 text-center font-medium">총경기수</th>
                          <th className="py-0.5 px-1 text-center font-medium border-l border-slate-200">종료수</th>
                          <th className="py-0.5 px-1 text-center font-medium border-l border-slate-200">진행수</th>
                          <th className="py-0.5 px-1 text-center font-medium border-l border-slate-200">대기수</th>
                        </tr>
                        <tr className="border-t border-[#e8e8ed]">
                          <td className="py-0.5 px-1 text-center font-medium">{total} <span className="text-slate-500 font-normal">({pct(total)}%)</span></td>
                          <td className="py-0.5 px-1 text-center font-medium border-l border-slate-100">{completedCount} <span className="text-slate-500 font-normal">({pct(completedCount)}%)</span></td>
                          <td className="py-0.5 px-1 text-center font-medium border-l border-slate-100">{ongoingCount} <span className="text-slate-500 font-normal">({pct(ongoingCount)}%)</span></td>
                          <td className="py-0.5 px-1 text-center font-medium border-l border-slate-100">{waitingCount} <span className="text-slate-500 font-normal">({pct(waitingCount)}%)</span></td>
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
                      className={`shrink-0 min-w-[1.75rem] w-7 py-0.5 rounded text-xs font-medium flex flex-col items-center justify-center leading-none ${statusColor} ${canSelect ? "cursor-pointer hover:opacity-80" : "cursor-default"}`}
                    >
                      {statusLabel.split("").map((c, i) => (
                        <span key={i}>{c}</span>
                      ))}
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
                      className="shrink-0 min-w-[1.75rem] w-7 py-1 rounded text-xs font-semibold leading-none text-white bg-[#0071e3] hover:bg-[#0077ed] transition-colors flex flex-col items-center justify-center"
                    >
                      <span>저</span>
                      <span>장</span>
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
                          <svg width="22" height="24" viewBox="0 0 24 26" fill="none" xmlns="http://www.w3.org/2000/svg" className="drop-shadow-sm">
                            {/* 목줄 고리 */}
                            <rect x="9" y="0.5" width="6" height="2.2" rx="1.1" fill={medalStroke} stroke={medalStroke} strokeWidth="0.5" />
                            {/* 목줄 (고리와 메달 연결) */}
                            <path d="M 10.5 2.7 L 11.2 4.2 L 12.8 4.2 L 13.5 2.7 L 12 3.8 Z" fill={medalStroke} opacity={0.9} />
                            {/* 메달 원판 */}
                            <circle cx="12" cy="13" r="9" fill={medalColor} stroke={medalStroke} strokeWidth="1.2" />
                            <circle cx="12" cy="13" r="6" fill="none" stroke="rgba(255,255,255,0.4)" strokeWidth="1" />
                            <text x="12" y="16" textAnchor="middle" fill="#fff" fontSize="10" fontWeight="bold" fontFamily="system-ui">{rank}</text>
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
        )}

        {navView === "myinfo" && (
          <div className="pt-4 space-y-2">
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
                  {getKakaoJsKey() && (
                    <div className="flex flex-wrap gap-2 mb-2">
                      <button
                        type="button"
                        onClick={() => {
                          setKakaoLoginStatus("리다이렉트 중...");
                          if (typeof window !== "undefined") initKakao();
                          loginWithKakao();
                        }}
                        className="px-3 py-1.5 rounded-lg text-sm font-medium bg-[#FEE500] text-[#191919] hover:bg-[#fdd835] transition-colors"
                      >
                        카카오 로그인
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          logoutKakao();
                          setMyInfo((prev) => ({ ...prev, profileImageUrl: undefined, email: undefined }));
                          setKakaoLoginStatus("카카오에서 로그아웃했습니다.");
                        }}
                        className="px-3 py-1.5 rounded-lg text-sm font-medium bg-slate-100 text-slate-700 hover:bg-slate-200 transition-colors"
                      >
                        카카오 로그아웃
                      </button>
                    </div>
                  )}
                  {kakaoLoginStatus && (
                    <p
                      className={`text-xs mb-1 px-2 py-1.5 rounded-lg ${
                        kakaoLoginStatus === "카카오로 로그인되었습니다."
                          ? "bg-amber-100 text-amber-900 font-medium border border-amber-200"
                          : "text-slate-500"
                      }`}
                    >
                      {kakaoLoginStatus}
                    </p>
                  )}
                  {!getKakaoJsKey() && (
                    <p className="text-xs text-amber-600 mb-1">
                      로컬: .env.local에 NEXT_PUBLIC_KAKAO_JAVASCRIPT_KEY 추가 후 개발 서버 재시작. 배포(Vercel): 프로젝트 설정 → Environment Variables에 동일 키 추가 후 재배포.
                    </p>
                  )}
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
          className={`flex flex-col items-center gap-0.5 py-2 px-4 min-w-0 rounded-xl transition-colors ${navView === "setting" ? "bg-[#0071e3]/10 text-[#0071e3] font-semibold" : "text-[#6e6e73] hover:text-[#1d1d1f] hover:bg-black/5"}`}
        >
          <img src="/game-mode-icon.png?v=2" alt="" className="w-10 h-10 object-contain" />
          <span className="text-sm font-medium leading-tight">경기 방식</span>
        </button>
        <button
          type="button"
          onClick={() => { setNavView("record"); setSelectedGameId(null); }}
          className={`flex flex-col items-center gap-0.5 py-2 px-4 min-w-0 rounded-xl transition-colors ${navView === "record" ? "bg-[#0071e3]/10 text-[#0071e3] font-semibold" : "text-[#6e6e73] hover:text-[#1d1d1f] hover:bg-black/5"}`}
        >
          <img src="/game-list-icon.png" alt="" className="w-10 h-10 object-contain" />
          <span className="text-sm font-medium leading-tight">경기 목록</span>
        </button>
        <button
          type="button"
          onClick={() => setNavView("myinfo")}
          className={`relative flex flex-col items-center gap-0.5 py-2 px-4 min-w-0 rounded-xl transition-colors ${navView === "myinfo" ? "bg-[#0071e3]/10 text-[#0071e3] font-semibold" : "text-[#6e6e73] hover:text-[#1d1d1f] hover:bg-black/5"} ${myInfo.profileImageUrl ? "ring-2 ring-green-500/70 ring-inset" : ""}`}
        >
          {myInfo.profileImageUrl && (
            <span className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-green-500 shrink-0" aria-hidden title="로그인됨" />
          )}
          <img src="/myinfo-icon.png" alt="" className="w-10 h-10 object-contain" />
          <span className="text-sm font-medium leading-tight">경기 이사</span>
        </button>
      </nav>

      {/* 경기 생성 전 확인 모달 */}
      {showRegenerateConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50" aria-modal="true" role="alertdialog" aria-labelledby="regenerate-confirm-title">
          <div className="bg-white rounded-2xl shadow-xl max-w-sm w-full p-4 space-y-3">
            <p id="regenerate-confirm-title" className="text-sm text-slate-700 leading-relaxed">
              이미 경기 현황에 경기가 있습니다. 경기를 다시 생성하면 현재까지의 경기 결과가 모두 사라집니다. 계속하시겠습니까?
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
