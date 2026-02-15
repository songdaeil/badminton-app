"use client";

import { useCallback, useEffect, useState } from "react";
import type { Grade, Member, Match } from "./types";

const STORAGE_KEY = "badminton-members";
const EVENT_STORAGE_KEY = "badminton-event";
const PRIMARY = "#3b82f6";
const PRIMARY_LIGHT = "#eff6ff";

interface EventInfo {
  location: string;
  dateTime: string;
}

function loadEvent(): EventInfo {
  if (typeof window === "undefined") return { location: "", dateTime: "" };
  try {
    const raw = localStorage.getItem(EVENT_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as EventInfo;
      return { location: parsed?.location ?? "", dateTime: parsed?.dateTime ?? "" };
    }
  } catch {}
  return { location: "", dateTime: "" };
}

function saveEvent(info: EventInfo) {
  if (typeof window === "undefined") return;
  localStorage.setItem(EVENT_STORAGE_KEY, JSON.stringify(info));
}

function formatDateTime(iso: string): string {
  if (!iso.trim()) return "";
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    const y = d.getFullYear();
    const m = d.getMonth() + 1;
    const day = d.getDate();
    const h = d.getHours();
    const min = d.getMinutes();
    const week = ["일", "월", "화", "수", "목", "금", "토"][d.getDay()];
    return `${m}월 ${day}일 ${week} ${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
  } catch {
    return iso;
  }
}

const GRADE_ORDER: Record<Grade, number> = { A: 0, B: 1, C: 2, D: 3 };

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

function loadMembers(): Member[] {
  if (typeof window === "undefined") return DEFAULT_MEMBERS;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Member[];
      return Array.isArray(parsed) && parsed.length > 0 ? parsed : DEFAULT_MEMBERS;
    }
  } catch {}
  return DEFAULT_MEMBERS;
}

function saveMembers(members: Member[]) {
  if (typeof window === "undefined") return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(members));
}

/** 참가 인원별 목표 경기 수 (多人轮转赛 기준: 6인 9경기, 8인 14경기 등) */
function getTargetTotalGames(n: number): number {
  const table: Record<number, number> = {
    4: 2,
    5: 5,
    6: 9,
    7: 14,
    8: 14,
    9: 18,
    10: 20,
    11: 33,
    12: 33,
  };
  if (table[n] !== undefined) return table[n];
  if (n <= 12) return 33;
  return Math.min(33, Math.floor((n * 11) / 4));
}

/** 라운드 r에서의 파트너 짝 (0 고정, 나머지 로테이션) */
function getPairsInRound(n: number, r: number): [number, number][] {
  const others = Array.from({ length: n - 1 }, (_, i) => i + 1);
  const pairedWithZero = 1 + (r % (n - 1));
  const rest = others.filter((x) => x !== pairedWithZero);
  const pairs: [number, number][] = [[0, pairedWithZero]];
  for (let i = 0; i < rest.length; i += 2) {
    if (i + 1 < rest.length) pairs.push([rest[i], rest[i + 1]]);
  }
  return pairs;
}

/** 라운드로빈 더블스: 목표 경기 수만큼만 대진 생성 (모두가 골고루 한 번씩 짝을 이루는 방식) */
function buildRoundRobinMatches(members: Member[], targetTotal: number): Match[] {
  const n = members.length;
  const matches: Match[] = [];
  const gamesPerRound = n >= 2 ? Math.floor((n / 2) * (n / 2 - 1) / 2) : 0;
  if (gamesPerRound <= 0) return matches;

  let round = 0;
  while (matches.length < targetTotal) {
    const pairs = getPairsInRound(n, round);
    for (let i = 0; i < pairs.length; i++) {
      for (let j = i + 1; j < pairs.length; j++) {
        if (matches.length >= targetTotal) break;
        const [a, b] = pairs[i];
        const [c, d] = pairs[j];
        matches.push({
          id: createId(),
          team1: { id: createId(), players: [members[a], members[b]] },
          team2: { id: createId(), players: [members[c], members[d]] },
          score1: null,
          score2: null,
          savedAt: null,
        });
      }
    }
    round++;
  }
  return matches;
}

function AddMemberForm({
  onAdd,
  primaryColor,
}: {
  onAdd: (name: string, gender: "M" | "F", grade: Grade) => void;
  primaryColor: string;
}) {
  const [name, setName] = useState("");
  const [gender, setGender] = useState<"M" | "F">("M");
  const [grade, setGrade] = useState<Grade>("B");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onAdd(name, gender, grade);
    setName("");
  };

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <p className="text-xs text-slate-500 mb-1">참가 인원 추가</p>
      <h2 className="text-base font-semibold text-slate-800 mb-3">새 참가자 등록</h2>
      <form onSubmit={handleSubmit} className="space-y-3">
        <div>
          <label className="block text-xs text-slate-500 mb-1">이름</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="이름 입력"
            className="w-full px-3 py-2 rounded-xl border border-slate-200 bg-slate-50 text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-200 focus:border-blue-400"
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs text-slate-500 mb-1">성별</label>
            <select
              value={gender}
              onChange={(e) => setGender(e.target.value as "M" | "F")}
              className="w-full px-3 py-2 rounded-xl border border-slate-200 bg-slate-50 text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-200"
            >
              <option value="M">남</option>
              <option value="F">여</option>
            </select>
          </div>
          <div>
            <label className="block text-xs text-slate-500 mb-1">급수</label>
            <select
              value={grade}
              onChange={(e) => setGrade(e.target.value as Grade)}
              className="w-full px-3 py-2 rounded-xl border border-slate-200 bg-slate-50 text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-200"
            >
              <option value="A">A</option>
              <option value="B">B</option>
              <option value="C">C</option>
              <option value="D">D</option>
            </select>
          </div>
        </div>
        <button
          type="submit"
          className="w-full py-2.5 rounded-xl font-medium text-white hover:opacity-90"
          style={{ backgroundColor: primaryColor }}
        >
          추가
        </button>
      </form>
    </section>
  );
}

export default function Home() {
  const [members, setMembers] = useState<Member[]>([]);
  const [matches, setMatches] = useState<Match[]>([]);
  const [scoreInputs, setScoreInputs] = useState<Record<string, { s1: string; s2: string }>>({});
  const [mounted, setMounted] = useState(false);
  const [eventLocation, setEventLocation] = useState("");
  const [eventDateTime, setEventDateTime] = useState("");
  const [editingField, setEditingField] = useState<"location" | "datetime" | null>(null);
  const [editTemp, setEditTemp] = useState("");
  /** 사용자가 선택한 '진행중' 매치 id 목록 (여러 코트 병렬 진행 가능) */
  const [selectedPlayingMatchIds, setSelectedPlayingMatchIds] = useState<string[]>([]);

  useEffect(() => {
    setMembers(loadMembers());
    const e = loadEvent();
    setEventLocation(e.location);
    setEventDateTime(e.dateTime);
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!mounted) return;
    saveMembers(members);
  }, [members, mounted]);

  useEffect(() => {
    if (!mounted) return;
    saveEvent({ location: eventLocation, dateTime: eventDateTime });
  }, [eventLocation, eventDateTime, mounted]);

  const openEdit = (field: "location" | "datetime") => {
    setEditingField(field);
    setEditTemp(field === "location" ? eventLocation : eventDateTime);
  };

  const confirmEdit = () => {
    if (editingField === "location") {
      setEventLocation(editTemp.trim());
    } else if (editingField === "datetime") {
      setEventDateTime(editTemp.trim());
    }
    setEditingField(null);
  };

  const doMatch = useCallback(() => {
    if (members.length < 4) return;
    const target = getTargetTotalGames(members.length);
    const shuffled = [...members].sort(() => Math.random() - 0.5);
    const newMatches = buildRoundRobinMatches(shuffled, target);
    const inputs: Record<string, { s1: string; s2: string }> = {};
    for (const m of newMatches) {
      inputs[m.id] = { s1: "", s2: "" };
    }
    setMatches(newMatches);
    setScoreInputs(inputs);
    setSelectedPlayingMatchIds([]);
  }, [members]);

  const saveResult = useCallback(
    (matchId: string) => {
      const input = scoreInputs[matchId];
      if (!input) return;
      const s1 = parseInt(input.s1, 10);
      const s2 = parseInt(input.s2, 10);
      if (Number.isNaN(s1) || Number.isNaN(s2) || s1 < 0 || s2 < 0) return;
      const match = matches.find((m) => m.id === matchId);
      if (!match) return;

      const winnerFirst = s1 > s2;
      const diff = Math.abs(s1 - s2);

      setMembers((prev) =>
        prev.map((m) => {
          const inTeam1 = match.team1.players.some((p) => p.id === m.id);
          const inTeam2 = match.team2.players.some((p) => p.id === m.id);
          if (inTeam1) {
            const won = winnerFirst;
            return {
              ...m,
              wins: m.wins + (won ? 1 : 0),
              losses: m.losses + (won ? 0 : 1),
              pointDiff: m.pointDiff + (won ? diff : -diff),
            };
          }
          if (inTeam2) {
            const won = !winnerFirst;
            return {
              ...m,
              wins: m.wins + (won ? 1 : 0),
              losses: m.losses + (won ? 0 : 1),
              pointDiff: m.pointDiff + (won ? diff : -diff),
            };
          }
          return m;
        })
      );

      setMatches((prev) =>
        prev.map((m) =>
          m.id === matchId
            ? { ...m, score1: s1, score2: s2, savedAt: new Date().toISOString() }
            : m
        )
      );
      /** 저장(종료)된 경기는 진행에서 제거 → 모두 쉬는 상태 반영 */
      setSelectedPlayingMatchIds((prev) => prev.filter((id) => id !== matchId));
      setScoreInputs((prev) => ({
        ...prev,
        [matchId]: { s1: "", s2: "" },
      }));
    },
    [matches, scoreInputs]
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
    setMembers((prev) => [
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
    ]);
  }, []);

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

  /** 진행 표식된 경기에만 참가한 선수 id = 지금 코트에서 게임 중인 인원. 나머지 = 쉬는 인원. */
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
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        <div className="text-slate-500">로딩 중...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 text-slate-800 max-w-md mx-auto flex flex-col">
      {/* 헤더: 로고 + 앱명 */}
      <header className="sticky top-0 z-20 bg-white border-b border-slate-200 shadow-sm">
        <div className="flex items-center gap-2 px-4 py-3">
          <span className="text-2xl" aria-hidden>🏸</span>
          <div>
            <h1 className="text-lg font-bold text-slate-800">배드민턴</h1>
            <p className="text-xs text-slate-500">2:2 매칭 · 랭킹</p>
          </div>
        </div>
        {/* 탭 */}
        <div className="flex px-2 pb-2 gap-1">
          <button
            type="button"
            onClick={() => scrollTo("section-info")}
            className="flex-1 py-2.5 rounded-xl text-sm font-medium text-white"
            style={{ backgroundColor: PRIMARY }}
          >
            모임정보
          </button>
          <button
            type="button"
            onClick={() => scrollTo("section-members")}
            className="flex-1 py-2.5 rounded-xl text-sm font-medium text-slate-600 bg-slate-100 hover:bg-slate-200"
          >
            참가인원
          </button>
          <button
            type="button"
            onClick={() => scrollTo("section-matches")}
            className="flex-1 py-2.5 rounded-xl text-sm font-medium text-slate-600 bg-slate-100 hover:bg-slate-200"
          >
            대진
          </button>
          <button
            type="button"
            onClick={() => scrollTo("section-ranking")}
            className="flex-1 py-2.5 rounded-xl text-sm font-medium text-slate-600 bg-slate-100 hover:bg-slate-200"
          >
            랭킹
          </button>
        </div>
      </header>

      <main className="flex-1 px-4 pb-24 space-y-5">
        {/* 모임 정보 (장소·시간·참가) - 참고 이미지 스타일 */}
        <section id="section-info" className="scroll-mt-4 pt-4">
          <div className="rounded-2xl border border-slate-200 bg-white overflow-hidden shadow-sm">
            <div className="px-4 py-3 border-b border-slate-100 flex items-center gap-2">
              <span className="text-red-500 text-lg leading-none">▸</span>
              <div>
                <h2 className="text-base font-semibold text-slate-800">모임 정보</h2>
                <p className="text-xs text-slate-500">2:2 매칭 (4명 이상)</p>
              </div>
            </div>
            <div className="divide-y divide-slate-100">
              {/* 날짜·시간 행 */}
              <div className="px-4 py-0">
                <button
                  type="button"
                  onClick={() => openEdit("datetime")}
                  className="flex items-center gap-3 w-full py-3 text-left"
                >
                  <span className="text-slate-400 text-lg shrink-0">🕐</span>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs text-slate-500">날짜·시간</p>
                    <p className={`text-sm truncate ${eventDateTime ? "text-slate-800" : "text-slate-400"}`}>
                      {eventDateTime ? formatDateTime(eventDateTime) : "날짜와 시간을 선택하세요"}
                    </p>
                  </div>
                  <span className="text-slate-300 shrink-0">›</span>
                </button>
                {editingField === "datetime" && (
                  <div className="px-4 pb-3 flex gap-2">
                    <input
                      type="datetime-local"
                      value={editTemp}
                      onChange={(e) => setEditTemp(e.target.value)}
                      className="flex-1 px-3 py-2 rounded-xl border border-slate-200 bg-slate-50 text-slate-800 text-sm focus:outline-none focus:ring-2 focus:ring-blue-200"
                    />
                    <button
                      type="button"
                      onClick={confirmEdit}
                      className="py-2 px-4 rounded-xl text-sm font-medium text-white shrink-0"
                      style={{ backgroundColor: PRIMARY }}
                    >
                      확인
                    </button>
                  </div>
                )}
              </div>
              {/* 장소 행 */}
              <div className="px-4 py-0">
                <button
                  type="button"
                  onClick={() => openEdit("location")}
                  className="flex items-center gap-3 w-full py-3 text-left"
                >
                  <span className="text-slate-400 text-lg shrink-0">📍</span>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs text-slate-500">장소</p>
                    <p className={`text-sm truncate ${eventLocation ? "text-slate-800" : "text-slate-400"}`}>
                      {eventLocation || "장소를 입력하세요"}
                    </p>
                  </div>
                  <span className="text-slate-300 shrink-0">›</span>
                </button>
                {editingField === "location" && (
                  <div className="px-4 pb-3 flex gap-2">
                    <input
                      type="text"
                      value={editTemp}
                      onChange={(e) => setEditTemp(e.target.value)}
                      placeholder="예: 강남구 · OO체육관"
                      className="flex-1 px-3 py-2 rounded-xl border border-slate-200 bg-slate-50 text-slate-800 text-sm placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-200"
                    />
                    <button
                      type="button"
                      onClick={confirmEdit}
                      className="py-2 px-4 rounded-xl text-sm font-medium text-white shrink-0"
                      style={{ backgroundColor: PRIMARY }}
                    >
                      확인
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* 참가 명단 카드 - 报名名单 스타일 */}
          <div id="section-members" className="rounded-2xl border border-slate-200 bg-white overflow-hidden shadow-sm mt-4 scroll-mt-4">
            <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between">
              <div>
                <h3 className="text-base font-semibold text-slate-800">참가 명단</h3>
                <p className="text-xs text-slate-500">아래에서 참가 인원을 추가·삭제할 수 있습니다</p>
              </div>
              <span className="shrink-0 px-2.5 py-1 rounded-full text-sm font-medium bg-blue-50 text-blue-600 border border-blue-100">
                {members.length}명
              </span>
            </div>
            <div className="p-3 flex flex-wrap gap-2">
              {members.map((m, i) => (
                <div
                  key={m.id}
                  className="flex items-center gap-2 pl-2 pr-3 py-2 rounded-xl bg-slate-50 border border-slate-200 min-w-[100px]"
                >
                  <span className="w-6 h-6 rounded-full bg-slate-200 text-slate-600 flex items-center justify-center text-xs font-semibold">
                    {i + 1}
                  </span>
                  <span className="text-sm font-medium text-slate-800 truncate">{m.name}</span>
                  <span className="text-xs text-slate-500">({m.grade})</span>
                  <button
                    type="button"
                    onClick={() => removeMember(m.id)}
                    className="ml-auto w-6 h-6 rounded-lg flex items-center justify-center text-slate-400 hover:bg-red-100 hover:text-red-600"
                    aria-label={`${m.name} 제거`}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          </div>
          <AddMemberForm onAdd={addMember} primaryColor={PRIMARY} />
        </section>

        {/* 대진 생성 카드 */}
        <section id="section-matches" className="scroll-mt-4">
          <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <p className="text-xs text-slate-500 mb-1">경기 생성</p>
            <h2 className="text-base font-semibold text-slate-800 mb-2">로테이션 대진</h2>
            <p className="text-xs text-slate-500 mb-3">
              모두가 골고루 짝을 이루는 방식입니다. 현재 {members.length}명 기준 목표 경기 수:{" "}
              <strong className="text-slate-700">{members.length >= 4 ? getTargetTotalGames(members.length) : "-"}경기</strong>
            </p>
            <button
              type="button"
              onClick={doMatch}
              disabled={members.length < 4}
              className="w-full py-3 rounded-xl font-semibold text-white transition opacity-90 hover:opacity-100 disabled:opacity-50 disabled:cursor-not-allowed"
              style={{ backgroundColor: PRIMARY }}
            >
              대진 생성 (4명 이상)
            </button>
            {members.length < 4 && (
              <p className="text-xs text-slate-400 mt-2 text-center">참가 인원이 4명 이상이어야 합니다.</p>
            )}
          </div>

          {/* 매치 목록 - 1줄씩 */}
          {matches.length > 0 && (
            <div className="rounded-2xl border border-slate-200 bg-white overflow-hidden shadow-sm mt-3">
              <div className="px-3 py-2 border-b border-slate-100">
                <p className="text-xs text-slate-500 mb-1">오늘의 매치 · 총 {matches.length}경기</p>
                {/* 총게임수 / 종료수 / 진행수 테이블 */}
                {(() => {
                  const total = matches.length;
                  const completedCount = matches.filter((m) => m.score1 != null && m.score2 != null).length;
                  const ongoingCount = playingMatches.length;
                  const pct = (n: number) => (total ? Math.round((n / total) * 100) : 0);
                  return (
                    <table className="w-full text-[11px] border border-slate-200 rounded overflow-hidden">
                      <thead>
                        <tr className="bg-slate-100 text-slate-600">
                          <th className="py-1 px-1.5 text-left font-medium">구분</th>
                          <th className="py-1 px-1.5 text-right font-medium">경기수</th>
                          <th className="py-1 px-1.5 text-right font-medium">비율</th>
                        </tr>
                      </thead>
                      <tbody className="bg-white text-slate-700">
                        <tr className="border-t border-slate-100">
                          <td className="py-1 px-1.5">총게임수</td>
                          <td className="py-1 px-1.5 text-right font-medium">{total}</td>
                          <td className="py-1 px-1.5 text-right">{pct(total)}%</td>
                        </tr>
                        <tr className="border-t border-slate-100">
                          <td className="py-1 px-1.5">종료수</td>
                          <td className="py-1 px-1.5 text-right font-medium">{completedCount}</td>
                          <td className="py-1 px-1.5 text-right">{pct(completedCount)}%</td>
                        </tr>
                        <tr className="border-t border-slate-100">
                          <td className="py-1 px-1.5">진행수</td>
                          <td className="py-1 px-1.5 text-right font-medium">{ongoingCount}</td>
                          <td className="py-1 px-1.5 text-right">{pct(ongoingCount)}%</td>
                        </tr>
                      </tbody>
                    </table>
                  );
                })()}
                {playingMatches.length > 0 && (
                  <p className="text-[10px] text-slate-400 mt-1">
                    진행 뱃지 다시 눌러 해제 · 가능 {playableMatches.length}경기
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
                  return (
                  <div
                    key={m.id}
                    className={`flex flex-nowrap items-center gap-x-1 px-2 py-0 text-xs overflow-x-auto ${isCurrent ? "bg-amber-50/50 hover:bg-amber-50/70" : isPlayable ? "bg-green-50/90 hover:bg-green-50 ring-1 ring-green-300/60 rounded-r-lg" : "bg-white hover:bg-slate-50/80"}`}
                  >
                    <span
                      className="shrink-0 w-5 h-5 rounded flex items-center justify-center font-semibold text-white text-[10px]"
                      style={{ backgroundColor: PRIMARY }}
                    >
                      {index + 1}
                    </span>
                    <button
                      type="button"
                      onClick={() => canSelect && togglePlayingMatch(m.id)}
                      title={canSelect ? (isCurrent ? "진행 해제" : "진행으로 선택") : undefined}
                      className={`shrink-0 w-9 py-0.5 rounded text-[10px] font-medium text-center ${statusColor} ${canSelect ? "cursor-pointer hover:opacity-80" : "cursor-default"}`}
                    >
                      {statusLabel}
                    </button>
                    <span className="min-w-0 flex-1 font-medium text-slate-700 text-left truncate max-w-[5.5rem]" title={m.team1.players.map((p) => p.name).join("·")}>
                      {m.team1.players.map((p) => p.name).join("·")}
                    </span>
                    <div className="shrink-0 w-14 flex items-center justify-center">
                      {m.score1 !== null && m.score2 !== null ? (
                        <span className="text-slate-600 font-medium text-center">
                          {m.score1}:{m.score2}
                        </span>
                      ) : (
                        <div className="flex items-center gap-0.5">
                          <input
                            type="number"
                            min={0}
                            max={99}
                            placeholder="0"
                            value={scoreInputs[m.id]?.s1 ?? ""}
                            onChange={(e) => updateScoreInput(m.id, "s1", e.target.value)}
                            className="w-6 h-5 rounded border border-slate-200 bg-slate-50 text-slate-800 text-center text-xs focus:outline-none focus:ring-1 focus:ring-blue-200"
                          />
                          <span className="text-slate-400 text-[10px]">:</span>
                          <input
                            type="number"
                            min={0}
                            max={99}
                            placeholder="0"
                            value={scoreInputs[m.id]?.s2 ?? ""}
                            onChange={(e) => updateScoreInput(m.id, "s2", e.target.value)}
                            className="w-6 h-5 rounded border border-slate-200 bg-slate-50 text-slate-800 text-center text-xs focus:outline-none focus:ring-1 focus:ring-blue-200"
                          />
                        </div>
                      )}
                    </div>
                    <span className="min-w-0 flex-1 font-medium text-slate-700 text-right truncate max-w-[5.5rem]" title={m.team2.players.map((p) => p.name).join("·")}>
                      {m.team2.players.map((p) => p.name).join("·")}
                    </span>
                    {m.score1 !== null && m.score2 !== null ? (
                      <div className="shrink-0 flex flex-col items-end text-[10px] text-slate-500" title={m.savedAt ? new Date(m.savedAt).toLocaleString("ko-KR") : undefined}>
                        <span className="font-medium">완료</span>
                        {m.savedAt && (
                          <span className="text-[9px] text-slate-400">{formatSavedAt(m.savedAt)}</span>
                        )}
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => saveResult(m.id)}
                        className="shrink-0 py-1 px-2 rounded text-[10px] font-medium text-white hover:opacity-90"
                        style={{ backgroundColor: PRIMARY }}
                      >
                        저장
                      </button>
                    )}
                  </div>
                  );
                })}
              </div>
            </div>
          )}
        </section>

        {/* 오늘의 랭킹 카드 */}
        <section id="section-ranking" className="scroll-mt-4">
          <div className="rounded-2xl border border-slate-200 bg-white overflow-hidden shadow-sm">
            <div className="px-4 py-3 border-b border-slate-100">
              <p className="text-xs text-slate-500">오늘의 랭킹</p>
              <h3 className="text-base font-semibold text-slate-800">승수 → 득실차 → 급수 순</h3>
            </div>
            <ul className="divide-y divide-slate-100">
              {ranking.map((m, i) => (
                <li key={m.id} className="flex items-center gap-3 px-4 py-3 hover:bg-slate-50/80">
                  <span
                    className="w-8 h-8 rounded-xl flex items-center justify-center text-sm font-bold flex-shrink-0 text-white"
                    style={{
                      backgroundColor: i < 3 ? PRIMARY : "#94a3b8",
                    }}
                  >
                    {i + 1}
                  </span>
                  <div className="flex-1 min-w-0">
                    <span className="font-medium text-slate-800">{m.name}</span>
                    <span className="text-slate-500 text-sm ml-1">({m.grade})</span>
                  </div>
                  <div className="text-right text-sm text-slate-600">
                    <span className="text-blue-600 font-medium">{m.wins}승</span>
                    <span className="text-slate-400 mx-1">/</span>
                    <span className="text-red-500/90">{m.losses}패</span>
                    <span className="text-slate-500 ml-1.5">
                      {m.pointDiff >= 0 ? "+" : ""}{m.pointDiff}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </section>
      </main>

      {/* 하단 네비게이션 */}
      <nav className="fixed bottom-0 left-0 right-0 max-w-md mx-auto bg-white border-t border-slate-200 flex justify-around py-2 shadow-[0_-2px_10px_rgba(0,0,0,0.05)]">
        <button
          type="button"
          onClick={() => scrollTo("section-info")}
          className="flex flex-col items-center gap-0.5 py-1 text-slate-600 hover:text-slate-900"
        >
          <span className="text-lg">📅</span>
          <span className="text-[10px] font-medium">모임정보</span>
        </button>
        <button
          type="button"
          onClick={() => scrollTo("section-members")}
          className="flex flex-col items-center gap-0.5 py-1 text-slate-600 hover:text-slate-900"
        >
          <span className="text-lg">👥</span>
          <span className="text-[10px] font-medium">참가인원</span>
        </button>
        <button
          type="button"
          onClick={() => scrollTo("section-matches")}
          className="flex flex-col items-center gap-0.5 py-1 text-slate-600 hover:text-slate-900"
        >
          <span className="text-lg">📋</span>
          <span className="text-[10px] font-medium">대진</span>
        </button>
        <button
          type="button"
          onClick={() => scrollTo("section-ranking")}
          className="flex flex-col items-center gap-0.5 py-1 text-slate-600 hover:text-slate-900"
        >
          <span className="text-lg">🏆</span>
          <span className="text-[10px] font-medium">랭킹</span>
        </button>
      </nav>
    </div>
  );
}
