"use client";

import { createContext, useContext, useMemo } from "react";
import type { GameSettings, MyInfo } from "@/lib/game-storage";
import type { GameMode, Grade, Member, Match } from "@/app/types";

/** 경기 방식 카테고리 항목 (아이콘 포함) */
export interface GameCategoryItem {
  id: string;
  label: string;
  Icon: React.ComponentType<{ size?: number | "responsive"; className?: string }>;
}

export interface GameViewContextValue {
  // ─── 설정 패널 ───
  GAME_CATEGORIES: readonly GameCategoryItem[];
  GAME_MODES: GameMode[];
  gameModeCategoryId: string;
  setGameModeCategoryId: (v: string) => void;
  gameModeId: string;
  setGameModeId: (v: string) => void;
  gameSettings: GameSettings;
  setGameSettings: React.Dispatch<React.SetStateAction<GameSettings>>;
  gameMode: GameMode;
  addGameToRecord: () => void;
  getTargetTotalGames: (n: number) => number;
  getMaxCourts: (n: number) => number;
  MINUTES_PER_21PT_GAME: number;
  formatEstimatedDuration: (minutes: number) => string;

  // ─── 공통 / 경기 상세 (Record 패널 상세 등) ───
  effectiveGameId: string | null;
  members: Member[];
  setMembers: React.Dispatch<React.SetStateAction<Member[]>>;
  matches: Match[];
  setMatches: React.Dispatch<React.SetStateAction<Match[]>>;
  scoreInputs: Record<string, { s1: string; s2: string }>;
  setScoreInputs: React.Dispatch<React.SetStateAction<Record<string, { s1: string; s2: string }>>>;
  gameName: string;
  setGameName: (v: string) => void;
  selectedPlayingMatchIds: string[];
  setSelectedPlayingMatchIds: React.Dispatch<React.SetStateAction<string[]>>;
  myProfileMemberId: string | null;
  setMyProfileMemberId: (v: string | null) => void;
  highlightMemberId: string | null;
  setHighlightMemberId: (v: string | null) => void;
  setNavView: (v: "setting" | "record" | "myinfo") => void;
  setShowRegenerateConfirm: (v: boolean) => void;
  doMatch: () => void;
  rosterChangedSinceGenerate: boolean;
  setRosterChangedSinceGenerate: (v: boolean) => void;
  triggerRosterEditCooldown: () => void;
  scrollTo: (id: string) => void;
  addMember: (name: string, gender: "M" | "F", grade: Grade) => void;
  addMemberAsMe: (name: string, gender: "M" | "F", grade: Grade) => void;
  removeMember: (id: string) => void;
  togglePlayingMatch: (matchId: string) => void;
  saveResult: (matchId: string) => void;
  updateScoreInput: (matchId: string, side: "s1" | "s2", value: string) => void;
  newMemberName: string;
  setNewMemberName: (v: string) => void;
  newMemberGender: "M" | "F";
  setNewMemberGender: (v: "M" | "F") => void;
  newMemberGrade: Grade;
  setNewMemberGrade: (v: Grade) => void;
  GRADE_ORDER: Record<Grade, number>;
  ranking: Member[];
  scoreLimit: number;
  TIME_OPTIONS_30MIN: readonly string[];
  formatSavedAt: (iso: string) => string;
  getMatchPlayerIds: (match: Match) => string[];
  playingMatchIdsSet: Set<string>;
  playingMatches: Match[];
  playableMatches: Match[];
  playableMatchIdsSet: Set<string>;
  gameSummaryFocusedRef: React.MutableRefObject<boolean>;

  // ─── 경기 목록 패널 ───
  loadGameList: () => string[];
  loadGame: (id: string) => import("@/lib/game-storage").GameData;
  selectedGameId: string | null;
  setSelectedGameId: (v: string | null) => void;
  listMenuOpenId: string | null;
  setListMenuOpenId: (v: string | null) => void;
  listRefreshKey: number;
  setListRefreshKey: React.Dispatch<React.SetStateAction<number>>;
  recordDetailClosing: boolean;
  setRecordDetailClosing: (v: boolean) => void;
  handleShareGame: () => void;
  setShareToast: (v: string | null) => void;
  encodeGameForShare: (data: import("@/lib/game-storage").GameData) => string;
  lastFirestoreUploadBytes: number | null;
  syncGameListToFirebase: (opts?: { added?: string; removed?: string }) => void;
  removeGameFromList: (gameId: string) => void;
  refreshListFromRemote: () => void;
  handleDeleteCard: (gameId: string) => void;
  handleCopyCard: (gameId: string) => void;
  handleShareCard: (gameId: string) => Promise<void>;
  onCloseRecordDetail: () => void;
  getCurrentUserUid: () => string | null;

  // ─── 나의 정보 패널 ───
  myInfo: MyInfo;
  setMyInfo: React.Dispatch<React.SetStateAction<MyInfo>>;
  saveMyInfo: (info: MyInfo) => void;
  profileEditOpen: boolean;
  setProfileEditOpen: (v: boolean) => void;
  profileEditClosing: boolean;
  setProfileEditClosing: (v: boolean) => void;
  setLoginGatePassed: (v: boolean) => void;
  signOutPhone: () => Promise<void>;
  signOutEmail: () => Promise<void>;
  getCurrentPhoneUser: () => { phoneNumber?: string } | null;
  getCurrentEmailUser: () => { email?: string } | null;
  isPhoneAuthAvailable: () => boolean;
  isEmailAuthAvailable: () => boolean;
  LOGIN_GATE_KEY: string;
  uploadProfileToFirestore: () => Promise<void>;
  loginMessage: string | null;
  setLoginMessage: (v: string | null) => void;
}

const GameViewContext = createContext<GameViewContextValue | null>(null);

export function useGameView(): GameViewContextValue {
  const ctx = useContext(GameViewContext);
  if (!ctx) throw new Error("useGameView must be used within GameViewProvider");
  return ctx;
}

interface GameViewProviderProps {
  value: GameViewContextValue;
  children: React.ReactNode;
}

export function GameViewProvider({ value, children }: GameViewProviderProps) {
  const memoValue = useMemo(() => value, [value]);
  return (
    <GameViewContext.Provider value={memoValue}>
      {children}
    </GameViewContext.Provider>
  );
}
