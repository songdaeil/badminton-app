"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { addGameToList, buildGameDataPayload, createGameId, DEFAULT_GAME_SETTINGS, DEFAULT_MYINFO, loadGame, loadGameList, removeGameFromList, saveGame, saveGameList, saveMyInfo } from "@/lib/game-storage";
import type { GameData, GameSettings, MyInfo } from "@/lib/game-storage";
import { ensureFirebase, getAuthInstance, getDb } from "@/lib/firebase";
import { getCurrentUserUid, getRemoteProfile, setRemoteProfile } from "@/lib/profile-sync";
import { deleteCurrentAccount } from "@/lib/account";
import { addSharedGame, deleteSharedGame, getFirestorePayloadSize, getSharedGame, isSyncAvailable, mergeGameData, shouldSkipSharedGameUpload, subscribeSharedGame, uploadSharedGameIfNeeded, type SharedGameWriteResult } from "@/lib/sync";
import {
  confirmPhoneCode,
  getCurrentPhoneUser,
  startPhoneAuth,
  signOutPhone,
} from "@/lib/phone-auth";
import { onAuthStateChanged, signOut as firebaseSignOut, type ConfirmationResult } from "firebase/auth";
import type { GameMode, Grade, Member, Match } from "./types";
import { IconCategorySword, IconCategoryUser, IconCategoryUsers, IconCategoryUsersRound } from "./components/category-icons";
import { NavIconGameList, NavIconGameMode, NavIconMyInfo } from "./components/nav-icons";
import { useGameListSync } from "@/app/hooks/useGameListSync";
import { applyMyProfileToMembers, buildRankingFromMatchesOnly, gameHasRecordedScore, isRecordedScore, recomputeMemberStatsFromMatches, resolveMyProfileMemberId, rosterOutOfSyncWithDraw, uniqueDrawPlayerCount } from "@/lib/match-stats";
import {
  createId,
  formatEstimatedDuration,
  formatSavedAt,
  GAME_MODES,
  getMaxCourts,
  getTargetTotalGames,
  generateMatchesByGameMode,
  GRADE_ORDER,
  MINUTES_PER_21PT_GAME,
  TIME_OPTIONS_30MIN,
} from "@/lib/game-mode-utils";
import { LOGIN_GATE_KEY, NAV_ORDER, PRIMARY, PRIMARY_LIGHT, PENDING_SHARE_KEY, PROFILE_UPLOADED_KEY, CONTACT_EMAIL } from "@/app/constants";
import { AddMemberForm } from "@/app/components/AddMemberForm";

function applySharedWriteResult(
  result: SharedGameWriteResult | void,
  data: GameData | undefined,
  setBytes: (n: number) => void,
  setToast: (s: string | null) => void
) {
  if (!result?.ok) return;
  if (data) setBytes(getFirestorePayloadSize(data));
  if (result.conflicts.length > 0) {
    setToast("다른 사람이 먼저 저장한 점수가 있어 그 매치는 덮지 않았습니다.");
    setTimeout(() => setToast(null), 4000);
  }
}

function shareLinkCopiedMessage(data: GameData): string {
  if (gameHasRecordedScore(data.matches)) {
    return "카톡에 붙여 넣어 보내 주세요. 받은 사람은 목록에 넣고 볼 수 있습니다.";
  }
  if ((data.matches ?? []).length > 0) {
    return "카톡에 붙여 넣어 보내 주세요. 받은 사람은 명단에 들어가고, 대진에 넣으려면 대진을 다시 만들어야 합니다.";
  }
  return "카톡에 붙여 넣어 보내 주세요. 받은 사람은 명단과 목록에 들어갑니다.";
}

function parseShareParam(raw: string): string | null {
  const t = raw.trim();
  if (!t) return null;
  try {
    const u = new URL(t);
    const q = u.searchParams.get("share");
    if (q) return q;
  } catch {
    /* 링크가 아니면 아래 규칙 */
  }
  const m = t.match(/share=([^&\s]+)/);
  if (m) return decodeURIComponent(m[1]);
  if (/^[A-Za-z0-9_-]{8,}$/.test(t)) return t;
  return null;
}

/** 내 프로필을 명단에 넣는다. 이미 있으면 그 칸을 나로 표시하고, 점수가 있거나 가득 차면 넣지 않는다. */
function joinSelfToGameData(
  data: GameData,
  profile: { uid?: string | null; name?: string; gender?: "M" | "F"; grade?: Grade }
): GameData {
  const uid = profile.uid;
  const name = profile.name?.trim() ?? "";
  if (!uid || !name) return data;
  const members = data.members ?? [];
  const existing = members.find((m) => m.linkedUid === uid);
  if (existing) {
    return { ...data, myProfileMemberId: existing.id };
  }
  const hasScore = gameHasRecordedScore(data.matches);
  if (hasScore) return data;
  const mode = GAME_MODES.find((m) => m.id === data.gameMode) ?? GAME_MODES[0];
  if (members.length >= (mode.maxPlayers ?? 12)) return data;
  const newId = createId();
  return {
    ...data,
    members: [
      ...members,
      {
        id: newId,
        name,
        gender: profile.gender === "F" ? "F" : "M",
        grade: profile.grade === "A" || profile.grade === "B" || profile.grade === "C" ? profile.grade : "D",
        wins: 0,
        losses: 0,
        pointDiff: 0,
        linkedUid: uid,
      },
    ],
    myProfileMemberId: newId,
  };
}

/** 경기 방식 카테고리 (상단 탭). 이미지 참고: 복식/단식/대항전/단체 등 */
const GAME_CATEGORIES = [
  { id: "doubles", label: "복식", Icon: IconCategoryUsers },
  { id: "singles", label: "단식", Icon: IconCategoryUser },
  { id: "contest", label: "대항전", Icon: IconCategorySword },
  { id: "team", label: "단체", Icon: IconCategoryUsersRound },
] as const;

const MAX_MEMBERS = 12;

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
  const [playingUpdatedAt, setPlayingUpdatedAt] = useState<string | undefined>(undefined);
  /** 전화 인증된 Firebase 세션이 있을 때만 true. 세션 깃발이 아니라 Auth 상태가 기준 */
  const [loginGatePassed, setLoginGatePassed] = useState(false);
  /** 오프라인 미지원: 네트워크 연결 여부. false면 쓰기 차단·배너 표시 */
  const [isOnline, setIsOnline] = useState(() => (typeof navigator !== "undefined" ? navigator.onLine : true));
  /** 로그인한 사용자 UID (프로필 Firestore 동기화용) */
  const [authUid, setAuthUid] = useState<string | null>(null);
  /** 이 uid의 서버 프로필이 있을 때만 true. 기기 깃발을 쓰지 않아 이전 계정과 섞이지 않음 */
  const [hasUploadedProfileAfterLogin, setHasUploadedProfileAfterLogin] = useState(false);
  /** 서버 프로필 조회가 끝나기 전에는 온보딩을 보여주지 않음 (재방문 시 빈 폼이 깜빡이지 않게) */
  const [profileCheckDone, setProfileCheckDone] = useState(false);
  /** 전화번호 로그인: 단계(idle | sending | code), 입력값, 에러, 인증 결과 */
  const [phoneStep, setPhoneStep] = useState<"idle" | "sending" | "code" | "error">("idle");
  const [phoneNumberInput, setPhoneNumberInput] = useState("");
  const [phoneCodeInput, setPhoneCodeInput] = useState("");
  const [phoneError, setPhoneError] = useState("");
  const phoneConfirmationResultRef = useRef<ConfirmationResult | null>(null);
  /** 하단 네비로 이동하는 화면: setting(경기 세팅) | record(경기 목록) | myinfo(나의 정보). 새로고침 시 마지막 탭 복원 */
  const [navView, setNavView] = useState<"setting" | "record" | "myinfo">(() => {
    if (typeof window === "undefined") return "record";
    const saved = sessionStorage.getItem("badminton_nav_view");
    if (saved === "setting" || saved === "myinfo" || saved === "record") return saved;
    return "record";
  });
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
  const [showWithdrawConfirm, setShowWithdrawConfirm] = useState(false);
  const [detailStep, setDetailStep] = useState<"people" | "draw" | "score">("people");
  const [joinLinkOpen, setJoinLinkOpen] = useState(false);
  const [joinLinkInput, setJoinLinkInput] = useState("");
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
  /** applyMyProfileToMembers에 넘길 나의 프로필 객체 (한 곳에서만 정의해 7곳에서 재사용) */
  const myProfileForMembers = useMemo(() => ({ name: myInfo.name, gender: myInfo.gender, grade: myInfo.grade ?? "D", uid: myInfo.uid }), [myInfo.name, myInfo.gender, myInfo.grade, myInfo.uid]);
  useEffect(() => {
    scoreInputsRef.current = scoreInputs;
  }, [scoreInputs]);
  /** 경기 목록에서 공유(shareId) 카드 최신 데이터 갱신 후 리스트 다시 그리기용 */
  const [listRefreshKey, setListRefreshKey] = useState(0);
  const { syncGameListToFirebase, refreshListFromRemote, bumpApplyGeneration, refreshListDisplay } = useGameListSync(
    authUid,
    useCallback(() => setListRefreshKey((k) => k + 1), [])
  );
  const enrollGameInMyList = useCallback((localId: string) => {
    addGameToList(localId);
    bumpApplyGeneration();
    refreshListDisplay();
    syncGameListToFirebase({ added: localId });
  }, [bumpApplyGeneration, refreshListDisplay, syncGameListToFirebase]);
  /** 경기 목록 상세·프로필 수정 등 섹션 하위 오버레이 열림 시 true → 캐러셀 스와이프 무시 */
  const overlayOpenRef = useRef(false);
  /** 오버레이(도움말·확인 모달) 스와이프 제스처용 */
  const overlayTouchStartRef = useRef({ x: 0, y: 0 });
  /** 본문 스크롤 영역 (당겨서 새로고침·백키 처리용) */
  const mainRef = useRef<HTMLElement | null>(null);
  /** 당겨서 새로고침: 터치 시작 시 Y·scrollTop, 터치 중 최대 당긴 거리 */
  const pullRef = useRef({ startY: 0, startScrollTop: 0, maxPull: 0 });
  /** 당겨서 새로고침 제스처가 시작된 시점의 섹션 (프로필 덮어쓰기는 나의 정보에서만 수행) */
  const pullSectionRef = useRef<"setting" | "record" | "myinfo">("setting");
  /** 경기 방식 섹션 재렌더 트리거 */
  const [settingRefreshKey, setSettingRefreshKey] = useState(0);
  /** 방금 Firestore에 업로드한 용량(바이트). 공유 경기 열람 시 표시 */
  const [lastFirestoreUploadBytes, setLastFirestoreUploadBytes] = useState<number | null>(null);
  const effectiveGameId = gameId ?? selectedGameId;
  /** 경기 상세에서 만든이(createdByUid 일치)만 요약·명단 수정·대진 생성 가능 */
  const isGameOwner = useMemo(() => {
    if (effectiveGameId == null) return false;
    const existing = loadGame(effectiveGameId);
    const uid = myInfo.uid ?? getCurrentUserUid();
    return Boolean(uid && existing.createdByUid && uid === existing.createdByUid);
  }, [effectiveGameId, myInfo.uid]);
  const isGameSummaryEditable = isGameOwner;
  const isOnRoster = useMemo(() => {
    const uid = myInfo.uid ?? getCurrentUserUid();
    return Boolean(uid && members.some((m) => m.linkedUid === uid));
  }, [members, myInfo.uid]);
  const hasSavedScore = useMemo(
    () => gameHasRecordedScore(matches),
    [matches]
  );
  const rosterOutOfSync = useMemo(
    () => rosterOutOfSyncWithDraw(members, matches),
    [members, matches]
  );
  const canRecordScores = isOnRoster && !rosterOutOfSync;
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
      setPlayingUpdatedAt(undefined);
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
          const localSaved = (data.matches ?? []).filter((m) => isRecordedScore(m)).length;
          const remoteSaved = (remote.matches ?? []).filter((m) => isRecordedScore(m)).length;
          if (localSaved > remoteSaved) {
            saveGame(id, { ...data, shareId: data.shareId });
            uploadSharedGameIfNeeded({ ...data, shareId: data.shareId })
              .then((result) => applySharedWriteResult(result, { ...data, shareId: data.shareId }, setLastFirestoreUploadBytes, setShareToast))
              .catch(() => {});
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
        setMyProfileMemberId(resolveMyProfileMemberId(loadedMembers, myInfo.uid ?? getCurrentUserUid(), myInfo.name));
        const inputs: Record<string, { s1: string; s2: string }> = {};
        for (const m of loadedMatches) {
          inputs[m.id] = { s1: m.score1 != null ? String(m.score1) : "", s2: m.score2 != null ? String(m.score2) : "" };
        }
        setScoreInputs(inputs);
        const matchIdSet = new Set(loadedMatches.map((m) => String(m.id)));
        const validPlayingIds = (data.playingMatchIds ?? []).filter((id) => matchIdSet.has(id));
        setSelectedPlayingMatchIds(validPlayingIds);
        setPlayingUpdatedAt(data.playingUpdatedAt ?? undefined);
        setRosterChangedSinceGenerate(
          loadedMatches.length === 0 || rosterOutOfSyncWithDraw(loadedMembers, loadedMatches)
        );
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
      uploadSharedGameIfNeeded(data)
        .then((result) => applySharedWriteResult(result, data, setLastFirestoreUploadBytes, setShareToast))
        .catch(() => {});
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
      unsub = subscribeSharedGame(
        shareId,
        (remote) => {
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
        setMyProfileMemberId(resolveMyProfileMemberId(remote.members, myInfo.uid ?? getCurrentUserUid(), myInfo.name));
        setRosterChangedSinceGenerate(
          (remote.matches?.length ?? 0) === 0 || rosterOutOfSyncWithDraw(remote.members, remote.matches)
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
        setPlayingUpdatedAt(remote.playingUpdatedAt ?? undefined);
      }
        },
        undefined,
        () => {
          removeGameFromList(effectiveGameId);
          syncGameListToFirebase({ removed: effectiveGameId, removedShareId: shareId });
          setSelectedGameId(null);
          setShareToast("만든이가 경기를 삭제했습니다.");
          setTimeout(() => setShareToast(null), 3000);
        }
      );
    });
    return () => {
      unsub?.();
    };
  }, [effectiveGameId, syncGameListToFirebase]);

  /** 공유 링크를 열면 내 목록에 넣는다. 점수가 있기 전에만 명단에 나를 넣는다. */
  const processShareAndOpenDetail = useCallback(
    (share: string) => {
      const existingIds = loadGameList();
      const alreadyInListId = existingIds.find(
        (id) => loadGame(id).shareId === share || loadGame(id).importedFromShare === share
      );
      const uid = myInfo.uid ?? getCurrentUserUid();
      const openJoined = (localId: string, data: GameData) => {
        const wasOnRoster = Boolean(uid && (data.members ?? []).some((m) => m.linkedUid === uid));
        const joined = joinSelfToGameData(data, {
          uid,
          name: myInfo.name,
          gender: myInfo.gender,
          grade: myInfo.grade,
        });
        const nowOnRoster = Boolean(uid && (joined.members ?? []).some((m) => m.linkedUid === uid));
        saveGame(localId, joined);
        enrollGameInMyList(localId);
        setNavView("record");
        setSelectedGameId(localId);
        router.replace("/?view=record", { scroll: false });
        const recorded = gameHasRecordedScore(data.matches);
        const hasDraw = (data.matches ?? []).length > 0;
        const mode = GAME_MODES.find((m) => m.id === data.gameMode) ?? GAME_MODES[0];
        if (uid && !wasOnRoster && !nowOnRoster) {
          if (recorded) {
            setShareToast("이미 점수가 있어 명단에 넣지 않았습니다. 경기는 볼 수 있습니다.");
          } else if ((data.members ?? []).length >= (mode.maxPlayers ?? 12)) {
            setShareToast("경기 인원이 가득 차 명단에 넣지 않았습니다. 경기는 볼 수 있습니다.");
          }
          setTimeout(() => setShareToast(null), 4000);
        } else if (uid && !wasOnRoster && nowOnRoster && hasDraw) {
          setShareToast("명단에 넣었습니다. 대진에 들어가려면 만든이가 대진을 다시 만들어야 합니다.");
          setTimeout(() => setShareToast(null), 4000);
        }
      };
      getSharedGame(share).then((remote) => {
        if (!remote) {
          if (alreadyInListId != null) {
            openJoined(alreadyInListId, loadGame(alreadyInListId));
            return;
          }
          setShareToast("경기를 찾지 못했습니다. 공유한 사람에게 링크를 다시 받아 주세요.");
          setTimeout(() => setShareToast(null), 4000);
          return;
        }
        const localId = alreadyInListId ?? createGameId();
        const local = alreadyInListId != null ? loadGame(alreadyInListId) : null;
        const base = local
          ? { ...mergeGameData(remote, local, uid), shareId: share }
          : { ...remote, playingMatchIds: remote.playingMatchIds ?? [], shareId: share };
        openJoined(localId, base);
      }).catch(() => {
        if (alreadyInListId != null) {
          openJoined(alreadyInListId, loadGame(alreadyInListId));
          return;
        }
        setShareToast("경기를 찾지 못했습니다. 네트워크를 확인하세요.");
        setTimeout(() => setShareToast(null), 4000);
      });
    },
    [router, enrollGameInMyList, myInfo.uid, myInfo.name, myInfo.gender, myInfo.grade]
  );

  /** 공유 링크(?share=...): 전화 로그인·프로필이 끝날 때까지 보관만. 인증을 건너뛰지 않음 */
  useEffect(() => {
    if (typeof window === "undefined") return;
    const share = searchParams.get("share");
    if (!share) return;
    sessionStorage.setItem(PENDING_SHARE_KEY, share);
  }, [searchParams]);

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

  /** 루트(/)에서 view=record 로 들어온 경우(공유 링크 등): 경기 목록 탭 표시 후 URL 정리. selectedGameId는 건드리지 않음(공유 링크로 상세 진입 시 유지) */
  useEffect(() => {
    if (typeof window === "undefined" || gameId != null) return;
    if (searchParams.get("view") !== "record") return;
    setNavView("record");
    router.replace("/", { scroll: false });
  }, [gameId, searchParams, router]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    sessionStorage.removeItem(LOGIN_GATE_KEY);
    localStorage.removeItem(PROFILE_UPLOADED_KEY);
  }, []);

  /** 탭 전환 시 sessionStorage에 저장 → 새로고침 시 해당 탭 유지 */
  useEffect(() => {
    if (typeof window === "undefined") return;
    sessionStorage.setItem("badminton_nav_view", navView);
  }, [navView]);

  /** 전화 인증된 Auth만 로그인으로 인정. 이메일만 있는 세션은 끊는다. */
  useEffect(() => {
    let cancelled = false;
    let unsub: (() => void) | null = null;
    ensureFirebase().then(() => {
      if (cancelled) return;
      const auth = getAuthInstance();
      if (!auth) return;
      unsub = onAuthStateChanged(auth, (user) => {
        if (user && !user.phoneNumber) {
          firebaseSignOut(auth).catch(() => {});
          setAuthUid(null);
          setLoginGatePassed(false);
          setHasUploadedProfileAfterLogin(false);
          return;
        }
        const uid = user?.uid ?? null;
        const phone = user?.phoneNumber ?? undefined;
        setAuthUid(uid);
        setLoginGatePassed(Boolean(uid && phone));
        if (!uid) {
          setHasUploadedProfileAfterLogin(false);
          setProfileCheckDone(false);
          const cleared = { ...DEFAULT_MYINFO };
          setMyInfo(cleared);
          saveMyInfo(cleared);
          return;
        }
        if (phone) {
          setMyInfo((prev) => {
            const next = { ...prev, uid, phoneNumber: phone };
            saveMyInfo(next);
            return next;
          });
        }
      });
    });
    return () => {
      cancelled = true;
      unsub?.();
    };
  }, []);

  /** 로그인 시 이 계정 서버 프로필만 반영. 없으면 온보딩 */
  useEffect(() => {
    if (!authUid || !loginGatePassed) {
      if (!loginGatePassed) setProfileCheckDone(false);
      return;
    }
    setProfileCheckDone(false);
    const phone = getCurrentPhoneUser()?.phoneNumber;
    getRemoteProfile(authUid)
      .then((remote) => {
        if (remote) {
          const withUid: MyInfo = {
            ...DEFAULT_MYINFO,
            ...remote,
            uid: authUid,
            phoneNumber: phone ?? remote.phoneNumber,
          };
          if (!withUid.name) withUid.name = "";
          if (!withUid.gender) withUid.gender = "M";
          setMyInfo(withUid);
          saveMyInfo(withUid);
          setHasUploadedProfileAfterLogin(true);
        } else {
          setMyInfo((prev) => {
            const keepDraft = prev.uid === authUid && Boolean(prev.name?.trim() || prev.birthDate);
            const next: MyInfo = keepDraft
              ? { ...prev, uid: authUid, phoneNumber: phone ?? prev.phoneNumber }
              : { ...DEFAULT_MYINFO, uid: authUid, phoneNumber: phone };
            saveMyInfo(next);
            return next;
          });
          setHasUploadedProfileAfterLogin(false);
        }
      })
      .catch(() => {
        setHasUploadedProfileAfterLogin(false);
      })
      .finally(() => {
        setProfileCheckDone(true);
      });
  }, [authUid, loginGatePassed]);

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

  useEffect(() => {
    if (!loginGatePassed || !isProfileComplete || typeof window === "undefined") return;
    const pending = sessionStorage.getItem(PENDING_SHARE_KEY);
    if (!pending) return;
    sessionStorage.removeItem(PENDING_SHARE_KEY);
    processShareAndOpenDetail(pending);
  }, [loginGatePassed, isProfileComplete, processShareAndOpenDetail]);

  const navIndex = NAV_ORDER.indexOf(navView);

  useEffect(() => {
    if (selectedGameId == null) return;
    const data = loadGame(selectedGameId);
    const ms = data.matches ?? [];
    const rec = gameHasRecordedScore(ms);
    const out = rosterOutOfSyncWithDraw(data.members ?? [], ms);
    if (ms.length === 0) setDetailStep("people");
    else if (out) setDetailStep("draw");
    else if (rec) setDetailStep("score");
    else setDetailStep("draw");
  }, [selectedGameId]);

  /** 경기 목록 상세·프로필 수정 열림 시 캐러셀 스와이프 무시용 ref 동기화 */
  useEffect(() => {
    overlayOpenRef.current = !!(selectedGameId || profileEditOpen || profileEditClosing || showWithdrawConfirm);
  }, [selectedGameId, profileEditOpen, profileEditClosing, showWithdrawConfirm]);

  /** 현재 탭 섹션 새로고침 (당겨서 새로고침 시 호출) */
  const doSectionRefresh = useCallback(() => {
    if (navView === "setting") setSettingRefreshKey((k) => k + 1);
    else if (navView === "record") refreshListFromRemote();
    else if (navView === "myinfo" && authUid) {
      getRemoteProfile(authUid).then((remote) => {
        const withUid = { ...(remote ?? {}), uid: authUid } as MyInfo;
        if (!withUid.name) withUid.name = "";
        if (!withUid.gender) withUid.gender = "M";
        setMyInfo(withUid);
        saveMyInfo(withUid);
        setHasUploadedProfileAfterLogin(!!remote);
      });
    }
  }, [navView, authUid, refreshListFromRemote]);

  const PULL_THRESHOLD = 56;

  /** 당겨서 새로고침: 터치 시작 */
  const handleMainTouchStart = useCallback((e: React.TouchEvent) => {
    const el = mainRef.current;
    if (!el || e.touches.length === 0) return;
    pullRef.current = { startY: e.touches[0].clientY, startScrollTop: el.scrollTop, maxPull: 0 };
  }, []);

  /** 당겨서 새로고침: 터치 이동 (맨 위에서만 당긴 거리 누적) */
  const handleMainTouchMove = useCallback((e: React.TouchEvent) => {
    const el = mainRef.current;
    if (!el || e.touches.length === 0) return;
    const { startY, startScrollTop } = pullRef.current;
    if (startScrollTop > 2) return;
    if (el.scrollTop > 2) return;
    const dy = e.touches[0].clientY - startY;
    if (dy > 0) pullRef.current.maxPull = Math.max(pullRef.current.maxPull, dy);
  }, []);

  /** 당겨서 새로고침: 터치 종료 시 임계치 넘으면 섹션 새로고침 */
  const handleMainTouchEnd = useCallback(() => {
    if (pullRef.current.maxPull >= PULL_THRESHOLD) doSectionRefresh();
    pullRef.current = { startY: 0, startScrollTop: 0, maxPull: 0 };
  }, [doSectionRefresh]);

  /** 백키 처리: 하위 레벨이면 상위로, 최상위면 백그라운드 (ref로 최신 값 참조) */
  const backKeyStateRef = useRef({ selectedGameId, profileEditOpen, profileEditClosing, showRegenerateConfirm, showGameModeHelp, showRecordHelp });
  backKeyStateRef.current = { selectedGameId, profileEditOpen, profileEditClosing, showRegenerateConfirm, showGameModeHelp, showRecordHelp };

  useEffect(() => {
    if (typeof window === "undefined" || !loginGatePassed) return;
    const state = { app: "badminton-root" };
    history.pushState(state, "", window.location.href);
    const handlePop = () => {
      const s = backKeyStateRef.current;
      if (s.selectedGameId) {
        setSelectedGameId(null);
        setListMenuOpenId(null);
        history.pushState(state, "", window.location.href);
        return;
      }
      if (s.profileEditOpen || s.profileEditClosing) {
        setProfileEditClosing(true);
        setProfileEditOpen(false);
        setTimeout(() => setProfileEditClosing(false), 250);
        history.pushState(state, "", window.location.href);
        return;
      }
      if (s.showRegenerateConfirm) {
        setShowRegenerateConfirm(false);
        history.pushState(state, "", window.location.href);
        return;
      }
      if (s.showGameModeHelp) {
        setShowGameModeHelp(false);
        history.pushState(state, "", window.location.href);
        return;
      }
      if (s.showRecordHelp) {
        setShowRecordHelp(false);
        history.pushState(state, "", window.location.href);
        return;
      }
      history.pushState(state, "", window.location.href);
      window.blur();
    };
    window.addEventListener("popstate", handlePop);
    return () => window.removeEventListener("popstate", handlePop);
  }, [loginGatePassed]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onOnline = () => setIsOnline(true);
    const onOffline = () => setIsOnline(false);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, []);

  /** 프로필을 Firestore에 업로드 (업로드 후에만 경기 방식·경기 목록 이용 가능) */
  const uploadProfileToFirestore = useCallback(async () => {
    const uid = getCurrentUserUid();
    if (!uid) return;
    const phone = getCurrentPhoneUser()?.phoneNumber ?? myInfo.phoneNumber;
    const toSave = { ...myInfo, uid, phoneNumber: phone };
    if (!myInfo.name?.trim()) {
      setLoginMessage("이름을 입력해 주세요.");
      setTimeout(() => setLoginMessage(null), 3000);
      return;
    }
    if (!myInfo.birthDate?.trim()) {
      setLoginMessage("생년월일을 입력해 주세요.");
      setTimeout(() => setLoginMessage(null), 3000);
      return;
    }
    if (!phone) {
      setLoginMessage("전화번호 확인 후 저장해 주세요.");
      setTimeout(() => setLoginMessage(null), 3000);
      return;
    }
    const ok = await setRemoteProfile(uid, toSave);
    if (ok) {
      setMyInfo(toSave);
      saveMyInfo(toSave);
      setHasUploadedProfileAfterLogin(true);
      setLoginMessage("저장했습니다.");
      setTimeout(() => setLoginMessage(null), 3000);
    } else {
      setLoginMessage("저장에 실패했습니다.");
      setTimeout(() => setLoginMessage(null), 3000);
    }
  }, [myInfo]);

  const handleSignOut = useCallback(async () => {
    await signOutPhone();
    const cleared = { ...DEFAULT_MYINFO };
    setMyInfo(cleared);
    saveMyInfo(cleared);
    setHasUploadedProfileAfterLogin(false);
    setProfileCheckDone(false);
    setLoginGatePassed(false);
    setAuthUid(null);
    setPhoneStep("idle");
    setPhoneNumberInput("");
    setPhoneCodeInput("");
    setPhoneError("");
    phoneConfirmationResultRef.current = null;
  }, []);

  useEffect(() => {
    if (!mounted || effectiveGameId === null) return;
    const existing = loadGame(effectiveGameId);
    const membersToSave = hasSavedScore
      ? members
      : applyMyProfileToMembers(members, myProfileMemberId, myProfileForMembers);
    const payload = buildGameDataPayload(existing, {
      members: membersToSave,
      matches,
      gameName: isGameSummaryEditable ? (gameName && gameName.trim() ? gameName.trim() : undefined) : existing.gameName,
      gameMode: gameModeId,
      gameSettings: isGameSummaryEditable ? gameSettings : (existing.gameSettings ?? gameSettings),
      myProfileMemberId: myProfileMemberId ?? undefined,
      playingMatchIds: selectedPlayingMatchIds,
      playingUpdatedAt,
    });
    /** 로컬 저장 후, 공유 경기(shareId)면 Firestore 업로드. 빈 payload로 로컬/서버 덮어쓰기 방지(데이터 유실 방지). */
    const runSave = (id: string, data: GameData) => {
      const localBefore = loadGame(id);
      if (shouldSkipSharedGameUpload(data, localBefore)) return;
      saveGame(id, data);
      if (!skipNextFirestorePush.current) {
        uploadSharedGameIfNeeded(data)
          .then((result) => applySharedWriteResult(result, data, setLastFirestoreUploadBytes, setShareToast))
          .catch(() => {});
      } else {
        skipNextFirestorePush.current = false;
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
  }, [effectiveGameId, members, matches, gameName, gameModeId, gameSettings, myProfileMemberId, selectedPlayingMatchIds, playingUpdatedAt, myInfo.name, myInfo.gender, myInfo.grade, mounted, isGameSummaryEditable, hasSavedScore]);


  /** 경기 생성 후 목록에 추가. 서버(sharedGames) 저장 성공 시에만 목록에 반영. 로그인·네트워크 필수. 오프라인 미지원. */
  const addGameToRecord = useCallback(() => {
    if (typeof navigator !== "undefined" && !navigator.onLine) {
      setShareToast("네트워크가 필요합니다.");
      setTimeout(() => setShareToast(null), 3000);
      return;
    }
    const creatorUid = myInfo.uid ?? getCurrentUserUid();
    if (!creatorUid || !isSyncAvailable()) {
      setShareToast("저장에 실패했습니다. 로그인 및 네트워크를 확인하세요.");
      setTimeout(() => setShareToast(null), 3000);
      return;
    }
    if (gameModeId === "individual_b") {
      setShareToast("이 경기 방식은 준비 중입니다.");
      setTimeout(() => setShareToast(null), 3000);
      return;
    }
    const id = createGameId();
    const mode = GAME_MODES.find((m) => m.id === gameModeId) ?? GAME_MODES[0];
    const defaultScore = mode.defaultScoreLimit ?? 21;
    const meId = createId();
    const meName = myInfo.name.trim();
    const me: Member = {
      id: meId,
      name: meName,
      gender: myInfo.gender ?? "M",
      grade: myInfo.grade ?? "D",
      wins: 0,
      losses: 0,
      pointDiff: 0,
      linkedUid: creatorUid,
    };
    const payload: GameData = {
      members: [me],
      matches: [],
      gameName: undefined,
      gameMode: gameModeId,
      gameSettings: { ...DEFAULT_GAME_SETTINGS, scoreLimit: defaultScore },
      myProfileMemberId: meId,
      createdAt: new Date().toISOString(),
      createdBy: meId,
      createdByName: meName || "-",
      createdByUid: creatorUid ?? null,
    };
    addSharedGame(payload)
      .then((newId) => {
        if (newId) {
          saveGame(id, { ...payload, shareId: newId });
          addGameToList(id);
          bumpApplyGeneration();
          setLastFirestoreUploadBytes(getFirestorePayloadSize({ ...payload, shareId: newId }));
          syncGameListToFirebase({ added: id });
          setNavView("record");
          setSelectedGameId(id);
        } else {
          setShareToast("저장에 실패했습니다. 네트워크를 확인하세요.");
          setTimeout(() => setShareToast(null), 3000);
        }
      })
      .catch(() => {
        setShareToast("저장에 실패했습니다. 네트워크를 확인하세요.");
        setTimeout(() => setShareToast(null), 3000);
      });
  }, [gameModeId, myInfo.name, myInfo.gender, myInfo.grade, myInfo.uid, syncGameListToFirebase, bumpApplyGeneration]);

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

  /** 목록 카드에서 해당 경기 삭제. 만든이만 Firestore 원본을 지운다. 참여자는 내 목록에서만 제거. */
  const handleDeleteCard = useCallback((gameId: string) => {
    if (typeof navigator !== "undefined" && !navigator.onLine) {
      setShareToast("네트워크가 필요합니다.");
      setTimeout(() => setShareToast(null), 3000);
      return;
    }
    const data = loadGame(gameId);
    const uid = myInfo.uid ?? getCurrentUserUid();
    const isOwner = Boolean(uid && data.createdByUid && uid === data.createdByUid);
    if (data.shareId && isSyncAvailable() && isOwner) {
      deleteSharedGame(data.shareId).catch(() => {});
    }
    removeGameFromList(gameId);
    syncGameListToFirebase({ removed: gameId, removedShareId: data.shareId ?? undefined });
    setSelectedGameId(null);
    setListMenuOpenId(null);
  }, [syncGameListToFirebase, myInfo.uid]);

  /** 경기 목록 카드에서 공유: ensureFirebase()·getDb() 호출 후 Firestore sharedGames에 addDoc(신규) 또는 setDoc(기존), shareId 링크 복사. 오프라인 시 차단. */
  const handleShareCard = useCallback(async (targetGameId: string) => {
    if (typeof navigator !== "undefined" && !navigator.onLine) {
      setShareToast("네트워크가 필요합니다.");
      setTimeout(() => setShareToast(null), 3000);
      return;
    }
    const data = loadGame(targetGameId);
    await ensureFirebase();
    const db = getDb();
    let shareParam: string | null = null;
    if (db) {
      if (data.shareId) {
        const payload = { ...data, shareId: data.shareId };
        const result = await uploadSharedGameIfNeeded(payload);
        if (result?.ok === true) {
          saveGame(targetGameId, payload);
          applySharedWriteResult(result, payload, setLastFirestoreUploadBytes, setShareToast);
          shareParam = data.shareId;
        }
      } else {
        const newId = await addSharedGame(data);
        if (newId) {
          const toSave = { ...data, shareId: newId };
          saveGame(targetGameId, toSave);
          shareParam = newId;
          setLastFirestoreUploadBytes(getFirestorePayloadSize(toSave));
        }
      }
    }
    if (!shareParam) {
      setShareToast("공유하려면 네트워크가 필요합니다.");
      setTimeout(() => setShareToast(null), 3000);
      return;
    }
    const url = `${typeof window !== "undefined" ? window.location.origin : ""}/?share=${shareParam}`;
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(url).then(
        () => {
          setShareToast(shareLinkCopiedMessage(data));
          setListMenuOpenId(null);
          setTimeout(() => setShareToast(null), 4500);
        },
        () => {
          setShareToast("복사에 실패했습니다.");
          setTimeout(() => setShareToast(null), 2500);
        }
      );
    } else {
      setShareToast(shareLinkCopiedMessage(data));
      setListMenuOpenId(null);
      setTimeout(() => setShareToast(null), 4500);
    }
  }, []);

  /** 경기 방식에서 선정한 로직으로만 경기 생성. 생성 직후 즉시 저장·공유 반영하여 첫 진입 시에도 경기 현황 유지. */
  const doMatch = useCallback(() => {
    if (effectiveGameId === null) return;
    if (hasSavedScore) {
      setShareToast("점수가 있으면 대진을 바꾸지 않습니다.");
      setTimeout(() => setShareToast(null), 3000);
      return;
    }
    if (!isGameOwner) {
      setShareToast("대진 생성은 만든이만 할 수 있습니다.");
      setTimeout(() => setShareToast(null), 3000);
      return;
    }
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
    const membersToSave = applyMyProfileToMembers(membersReset, myProfileMemberId, myProfileForMembers);
    setMatches(newMatches);
    setScoreInputs(inputs);
    setSelectedPlayingMatchIds([]);
    const playAt = new Date().toISOString();
    setPlayingUpdatedAt(playAt);
    setMembers((prev) =>
      prev.map((m) => ({ ...m, wins: 0, losses: 0, pointDiff: 0 }))
    );
    setRosterChangedSinceGenerate(false);
    matchGenerateDoneAtRef.current = Date.now();
    setDetailStep("draw");

    const existing = loadGame(effectiveGameId);
    const payload = buildGameDataPayload(existing, {
      members: membersToSave,
      matches: newMatches,
      gameName: gameName && gameName.trim() ? gameName.trim() : undefined,
      gameMode: gameModeId,
      gameSettings,
      myProfileMemberId: myProfileMemberId ?? undefined,
      playingMatchIds: [],
      playingUpdatedAt: playAt,
    });
    saveGame(effectiveGameId, payload);
    uploadSharedGameIfNeeded(payload)
      .then((result) => applySharedWriteResult(result, payload, setLastFirestoreUploadBytes, setShareToast))
      .catch(() => {});
  }, [effectiveGameId, gameModeId, gameName, gameSettings, members, myProfileMemberId, myInfo.name, myInfo.gender, myInfo.grade, isGameOwner, hasSavedScore]);

  const scoreLimit = Math.max(1, gameSettings.scoreLimit || 21);

  const saveResult = useCallback(
    (matchId: string) => {
      const input = scoreInputs[matchId];
      if (!input) return;
      if (input.s1.trim() === "" || input.s2.trim() === "") {
        setShareToast("양쪽 점수를 입력해 주세요.");
        setTimeout(() => setShareToast(null), 3000);
        return;
      }
      const s1 = parseInt(input.s1, 10);
      const s2 = parseInt(input.s2, 10);
      if (Number.isNaN(s1) || Number.isNaN(s2) || s1 < 0 || s2 < 0) return;
      if (s1 === 0 && s2 === 0) {
        setShareToast("0-0은 저장하지 않습니다. 점수를 입력해 주세요.");
        setTimeout(() => setShareToast(null), 3000);
        return;
      }
      if (s1 > scoreLimit || s2 > scoreLimit) return;
      if (effectiveGameId === null) return;
      if (!isOnRoster) {
        setShareToast("명단에 있어야 점수를 기록할 수 있습니다.");
        setTimeout(() => setShareToast(null), 3000);
        return;
      }
      if (rosterOutOfSync) {
        setShareToast("대진을 다시 만든 뒤에 점수를 기록할 수 있습니다.");
        setTimeout(() => setShareToast(null), 3000);
        return;
      }
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
      setPlayingUpdatedAt(now);
      setScoreInputs((prev) => ({ ...prev, [matchId]: { s1: String(s1), s2: String(s2) } }));

      const membersToSave = hasSavedScore
        ? nextMembers
        : applyMyProfileToMembers(nextMembers, myProfileMemberId, myProfileForMembers);
      const payload = buildGameDataPayload(existing, {
        members: membersToSave,
        matches: nextMatches,
        gameName: gameName && gameName.trim() ? gameName.trim() : undefined,
        gameMode: gameModeId,
        gameSettings,
        myProfileMemberId: myProfileMemberId ?? undefined,
        playingMatchIds: (existing.playingMatchIds ?? selectedPlayingMatchIds).filter((id) => id !== matchId),
        playingUpdatedAt: now,
      });
      saveGame(effectiveGameId, payload);
      if (saveResultFirestoreTimerRef.current) clearTimeout(saveResultFirestoreTimerRef.current);
      const gameIdToUpload = effectiveGameId;
      saveResultFirestoreTimerRef.current = setTimeout(() => {
        saveResultFirestoreTimerRef.current = null;
        const data = loadGame(gameIdToUpload);
        uploadSharedGameIfNeeded(data)
          .then((result) => applySharedWriteResult(result, data, setLastFirestoreUploadBytes, setShareToast))
          .catch(() => {});
      }, SAVE_RESULT_FIRESTORE_DEBOUNCE_MS);
    },
    [matches, scoreInputs, scoreLimit, myProfileMemberId, myInfo.name, myInfo.gender, myInfo.grade, effectiveGameId, gameName, gameModeId, gameSettings, members, selectedPlayingMatchIds, isOnRoster, rosterOutOfSync, hasSavedScore]
  );

  const updateScoreInput = useCallback((matchId: string, side: "s1" | "s2", value: string) => {
    setScoreInputs((prev) => ({
      ...prev,
      [matchId]: { ...prev[matchId], [side]: value },
    }));
  }, []);

  const addMember = useCallback((name: string, gender: "M" | "F", grade: Grade) => {
    if (!isGameOwner) return;
    if (hasSavedScore) return;
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
    const membersToSave = applyMyProfileToMembers(nextMembers, myProfileMemberId, myProfileForMembers);
    const payload = buildGameDataPayload(existing, {
      members: membersToSave,
      matches,
      gameName: gameName && gameName.trim() ? gameName.trim() : undefined,
      gameMode: gameModeId,
      gameSettings,
      myProfileMemberId: myProfileMemberId ?? undefined,
      playingMatchIds: selectedPlayingMatchIds,
    });
    saveGame(effectiveGameId, payload);
    /* Firestore 업로드는 디바운스 runSave에서 일괄 처리 */
  }, [gameModeId, members, effectiveGameId, myProfileMemberId, myInfo.name, myInfo.gender, myInfo.grade, gameName, gameModeId, gameSettings, matches, selectedPlayingMatchIds, isGameOwner, hasSavedScore]);

  /** 프로필로 나 추가 시 사용: 나의 프로필에 내포된 UID로 연동(linkedUid) 멤버 추가 후 '나'로 설정 */
  const addMemberAsMe = useCallback((name: string, gender: "M" | "F", grade: Grade) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    if (hasSavedScore) return;
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
    const membersToSave = applyMyProfileToMembers(nextMembers, newId, myProfileForMembers);
    const payload = buildGameDataPayload(existing, {
      members: membersToSave,
      matches,
      gameName: gameName && gameName.trim() ? gameName.trim() : undefined,
      gameMode: gameModeId,
      gameSettings,
      myProfileMemberId: newId,
      playingMatchIds: selectedPlayingMatchIds,
    });
    saveGame(effectiveGameId, payload);
    /* Firestore 업로드는 디바운스 runSave에서 일괄 처리 */
  }, [gameModeId, myInfo.uid, members, effectiveGameId, myInfo.name, myInfo.gender, myInfo.grade, gameName, gameModeId, gameSettings, matches, selectedPlayingMatchIds, hasSavedScore]);

  const removeMember = useCallback((id: string) => {
    if (hasSavedScore) return;
    const uid = myInfo.uid ?? getCurrentUserUid();
    const target = members.find((m) => m.id === id);
    const isSelf = Boolean(uid && target?.linkedUid && target.linkedUid === uid);
    if (!isGameOwner && !isSelf) return;
    rosterEditCooldownUntilRef.current = Date.now() + 1500;
    const nextMembers = members.filter((m) => m.id !== id);
    setMembers(() => nextMembers);
    setRosterChangedSinceGenerate(true);
    if (myProfileMemberId === id) setMyProfileMemberId(null);
    if (effectiveGameId === null) return;
    const existing = loadGame(effectiveGameId);
    const membersToSave = applyMyProfileToMembers(nextMembers, myProfileMemberId !== id ? myProfileMemberId : null, myProfileForMembers);
    const payload = buildGameDataPayload(existing, {
      members: membersToSave,
      matches,
      gameName: gameName && gameName.trim() ? gameName.trim() : undefined,
      gameMode: gameModeId,
      gameSettings,
      myProfileMemberId: myProfileMemberId === id ? undefined : myProfileMemberId ?? undefined,
      playingMatchIds: selectedPlayingMatchIds,
    });
    saveGame(effectiveGameId, payload);
    /* Firestore 업로드는 디바운스 runSave에서 일괄 처리 */
  }, [members, effectiveGameId, myProfileMemberId, myInfo.name, myInfo.gender, myInfo.grade, myInfo.uid, gameName, gameModeId, gameSettings, matches, selectedPlayingMatchIds, isGameOwner, hasSavedScore]);

  /** 경기 결과 = 경기 현황(matches)만으로 산출 */
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
  const playingMatchIdsSet = useMemo(
    () => new Set(selectedPlayingMatchIds.map((id) => String(id))),
    [selectedPlayingMatchIds]
  );
  const playingMatches = useMemo(
    () =>
      matches.filter(
        (m) => playingMatchIdsSet.has(String(m.id)) && !isRecordedScore(m)
      ),
    [matches, playingMatchIdsSet]
  );

  /** 진행 표식된 경기에만 참가한 선수 id = 지금 코트에서 경기 중인 인원. 나머지 = 쉬는 인원. */
  const playingIds = useMemo(() => {
    const s = new Set<string>();
    for (const pm of playingMatches) {
      for (const id of getMatchPlayerIds(pm)) s.add(String(id));
    }
    return s;
  }, [playingMatches]);

  /** 쉬는 인원 id 집합 (진행 외 전원 = 종료한 사람 포함 모두 쉬는 중) */
  const restingIds = useMemo(
    () => new Set(members.map((m) => String(m.id)).filter((id) => !playingIds.has(id))),
    [members, playingIds]
  );
  const waitingMembers = useMemo(
    () => members.filter((m) => !playingIds.has(String(m.id))),
    [members, playingIds]
  );

  /**
   * 가능 = 바로 시작할 수 있는 경기.
   * - 진행 중인 경기가 하나도 없으면 → 종료 이외의 모든 경기를 가능으로 표시.
   * - 진행 중인 경기가 있으면 → 4명 모두 진행 외 인원인 경기만 가능.
   * 진행 중 = 선택됐고 아직 미종료인 경기만 (종료된 경기는 진행에서 제외).
   */
  const hasPlayingInList = useMemo(
    () =>
      selectedPlayingMatchIds.some((id) => {
        const m = matches.find((x) => String(x.id) === String(id));
        return m != null && !isRecordedScore(m);
      }),
    [selectedPlayingMatchIds, matches]
  );
  const noPlayingSelected = !hasPlayingInList;
  const playableMatches = useMemo(
    () =>
      matches.filter((m) => {
        const isFinished = isRecordedScore(m);
        if (isFinished) return false;
        if (playingMatchIdsSet.has(String(m.id))) return false;
        if (noPlayingSelected) return true; // 진행 없음 → 종료 이외 전부 가능
        const ids = getMatchPlayerIds(m);
        return ids.length === 4 && ids.every((id) => restingIds.has(String(id)));
      }),
    [matches, playingMatchIdsSet, noPlayingSelected, restingIds]
  );
  const canStartNext = playableMatches.length > 0;
  /** 가능한 경기 id 집합 (표식 반영용, id 문자열 통일) */
  const playableMatchIdsSet = useMemo(
    () => new Set(playableMatches.map((m) => String(m.id))),
    [playableMatches]
  );

  /**
   * 진행 토글: 한 사람은 한 경기에만 진행으로 있을 수 있음 (중복 불가).
   * 새로 진행에 넣을 때, 이미 진행인 경기 중 이 경기와 선수가 겹치면 해당 경기는 진행에서 제거.
   */
  const togglePlayingMatch = (matchId: string) => {
    if (!isOnRoster) {
      setShareToast("명단에 있어야 진행을 바꿀 수 있습니다.");
      setTimeout(() => setShareToast(null), 3000);
      return;
    }
    if (rosterOutOfSync) {
      setShareToast("대진을 다시 만든 뒤에 진행을 바꿀 수 있습니다.");
      setTimeout(() => setShareToast(null), 3000);
      return;
    }
    const match = matches.find((m) => m.id === matchId);
    if (!match) return;
    playingSelectionCooldownUntilRef.current = Date.now() + 2000;
    setPlayingUpdatedAt(new Date().toISOString());
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
      <div className="min-h-screen bg-[#f3f6fb] flex items-center justify-center">
        <div className="text-[#6e6e73] text-base font-medium">로딩 중...</div>
      </div>
    );
  }

  if (!loginGatePassed) {
    return (
      <div className="min-h-screen min-h-[100dvh] bg-[#f3f6fb] text-[#1d1d1f] flex flex-col items-center justify-center px-4 py-8">
        <div className="w-full max-w-sm flex flex-col items-center gap-8">
          <div className="text-center space-y-2">
            <h1 className="text-2xl font-bold text-[#1d1d1f] tracking-tight">경기 이사</h1>
            <p className="text-base text-slate-500">전화번호로 본인 확인합니다. 처음이면 이어서 이름을 넣고, 이미 쓰면 바로 들어갑니다.</p>
          </div>
          <div className="w-full space-y-3">
            <div className="space-y-2">
                  <p className="text-base text-slate-600 font-medium">전화번호</p>
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
                        className="w-full px-3 py-3 rounded-xl border border-slate-200 bg-white text-base focus:outline-none focus:ring-2 focus:ring-[#0071e3]/25 focus:border-[#0071e3]"
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
                        className="w-full py-3 min-h-11 rounded-full text-base font-medium bg-slate-800 text-white hover:bg-slate-700 transition-colors btn-tap"
                      >
                        인증문자 보내기
                      </button>
                    </>
                  )}
                  {phoneStep === "sending" && (
                    <p className="text-center text-base text-slate-500 py-2">전송 중...</p>
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
                        className="w-full px-3 py-3 rounded-xl border border-slate-200 bg-white text-base font-numeric focus:outline-none focus:ring-2 focus:ring-[#0071e3]/25 focus:border-[#0071e3]"
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
                          className="flex-1 py-3 min-h-11 rounded-full text-base font-medium text-slate-600 bg-slate-100 hover:bg-slate-200 transition-colors btn-tap"
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
                              const nextInfo = { ...DEFAULT_MYINFO, ...myInfo, phoneNumber, uid: uid ?? undefined };
                              setMyInfo(nextInfo);
                              saveMyInfo(nextInfo);
                              setPhoneStep("idle");
                            } catch (e) {
                              const msg = e instanceof Error ? e.message : "인증에 실패했습니다.";
                              setPhoneError(msg);
                              setPhoneStep("code");
                            }
                          }}
                          className="flex-1 py-3 min-h-11 rounded-full text-base font-medium text-white bg-[#0071e3] hover:bg-[#0077ed] transition-colors btn-tap"
                        >
                          인증 완료
                        </button>
                      </div>
                    </>
                  )}
                  {phoneError && (
                    <p className="text-base text-amber-600" role="alert">
                      {phoneError}
                    </p>
                  )}
                </div>

            <p className="text-center pt-4">
              <a
                href="/privacy.html"
                target="_blank"
                rel="noopener noreferrer"
                className="text-base text-slate-500 underline hover:text-slate-700"
              >
                개인정보 처리방침
              </a>
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (!profileCheckDone) {
    return (
      <div className="min-h-screen bg-[#f3f6fb] flex items-center justify-center">
        <div className="text-[#6e6e73] text-base font-medium">로딩 중...</div>
      </div>
    );
  }

  if (!isProfileComplete) {
    return (
      <div className="min-h-screen min-h-[100dvh] bg-[#f3f6fb] text-[#1d1d1f] flex flex-col items-center justify-center px-4 py-8">
        <div className="w-full max-w-sm flex flex-col items-center gap-6">
          <div className="text-center space-y-2">
            <h1 className="text-2xl font-bold text-[#1d1d1f] tracking-tight">경기 이사</h1>
            <p className="text-base text-slate-500">경기를 쓰려면 이름과 생년월일이 필요합니다.</p>
          </div>
          <div className="w-full space-y-3">
            <div className="space-y-1.5">
              <label className="text-base text-slate-600 font-medium">이름</label>
              <input
                type="text"
                value={myInfo.name}
                onChange={(e) => {
                  const next = { ...myInfo, name: e.target.value };
                  setMyInfo(next);
                  saveMyInfo(next);
                }}
                placeholder="이름"
                className="w-full px-3 py-3 rounded-xl border border-slate-200 bg-white text-base focus:outline-none focus:ring-2 focus:ring-[#0071e3]/25 focus:border-[#0071e3]"
                aria-label="이름"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-base text-slate-600 font-medium">생년월일</label>
              <input
                type="date"
                value={myInfo.birthDate ?? ""}
                onChange={(e) => {
                  const next = { ...myInfo, birthDate: e.target.value || undefined };
                  setMyInfo(next);
                  saveMyInfo(next);
                }}
                className="w-full px-3 py-3 rounded-xl border border-slate-200 bg-white text-base focus:outline-none focus:ring-2 focus:ring-[#0071e3]/25 focus:border-[#0071e3]"
                aria-label="생년월일"
              />
            </div>
            <div className="flex gap-2">
              <div className="flex-1 space-y-1.5">
                <label className="text-base text-slate-600 font-medium">성별</label>
                <select
                  value={myInfo.gender}
                  onChange={(e) => {
                    const next = { ...myInfo, gender: e.target.value as "M" | "F" };
                    setMyInfo(next);
                    saveMyInfo(next);
                  }}
                  className="w-full px-3 py-3 rounded-xl border border-slate-200 bg-white text-base focus:outline-none focus:ring-2 focus:ring-[#0071e3]/25"
                  aria-label="성별"
                >
                  <option value="M">남</option>
                  <option value="F">여</option>
                </select>
              </div>
              <div className="flex-1 space-y-1.5">
                <label className="text-base text-slate-600 font-medium">급수</label>
                <select
                  value={myInfo.grade ?? "D"}
                  onChange={(e) => {
                    const next = { ...myInfo, grade: e.target.value as Grade };
                    setMyInfo(next);
                    saveMyInfo(next);
                  }}
                  className="w-full px-3 py-3 rounded-xl border border-slate-200 bg-white text-base focus:outline-none focus:ring-2 focus:ring-[#0071e3]/25"
                  aria-label="급수"
                >
                  <option value="A">A</option>
                  <option value="B">B</option>
                  <option value="C">C</option>
                  <option value="D">D</option>
                </select>
              </div>
            </div>
            <button
              type="button"
              onClick={uploadProfileToFirestore}
              className="w-full py-3 min-h-11 rounded-full text-base font-medium text-white bg-[#0071e3] hover:bg-[#0077ed] transition-colors btn-tap"
            >
              시작하기
            </button>
            {loginMessage && (
              <p className="text-base text-slate-600 text-center">{loginMessage}</p>
            )}
            <button
              type="button"
              onClick={handleSignOut}
              className="w-full py-3 min-h-11 rounded-full text-base font-medium text-slate-600 bg-slate-100 hover:bg-slate-200 transition-colors btn-tap"
            >
              다른 번호로
            </button>
            <p className="text-center pt-2">
              <a
                href="/privacy.html"
                target="_blank"
                rel="noopener noreferrer"
                className="text-base text-slate-500 underline hover:text-slate-700"
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
    <div className="min-h-screen bg-[#f3f6fb] text-[#1d1d1f] max-w-md mx-auto flex flex-col">
      {!isOnline && (
        <div className="bg-amber-500 text-white text-center text-base py-2 px-3" role="alert">
          오프라인입니다. 네트워크가 필요합니다.
        </div>
      )}
      {/* 헤더 - 흰 카드 + 아주 연한 파란 톤 */}
      <header className="sticky top-0 z-20 bg-[#f7faff] border-b border-[#e8eef6] safe-area-pb">
        <div className="flex items-center gap-3 px-3 py-4">
          <h1 className="text-[1.25rem] font-semibold tracking-tight text-[#1d1d1f] flex items-center gap-1.5">
            {navView === "setting" && (
              <>
                새 경기
                <button
                  type="button"
                  onClick={() => setShowGameModeHelp(true)}
                  className="w-10 h-10 flex items-center justify-center rounded-full bg-[#e8eef6] text-slate-600 hover:bg-[#dce6f2] text-base font-medium transition-colors"
                  aria-label="도움말"
                >
                  ?
                </button>
              </>
            )}
            {navView === "record" && (
              <>
                오늘 경기
                <button
                  type="button"
                  onClick={() => setShowRecordHelp(true)}
                  className="w-10 h-10 flex items-center justify-center rounded-full bg-[#e8eef6] text-slate-600 hover:bg-[#dce6f2] text-base font-medium transition-colors"
                  aria-label="도움말"
                >
                  ?
                </button>
              </>
            )}
            {navView === "myinfo" && "내 정보"}
          </h1>
        </div>
      </header>

      {/* 경기 방식 도움말 팝업 */}
      {showGameModeHelp && (
        <>
          <div className="fixed inset-0 z-30 bg-black/20" aria-hidden onClick={() => setShowGameModeHelp(false)} />
          <div
            className="fixed left-1/2 top-1/2 z-40 w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-3xl bg-white p-4 shadow-[0_12px_32px_rgba(47,91,160,0.16)] border border-[#e8eef6]"
            onTouchStart={(e) => { overlayTouchStartRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY }; }}
            onTouchEnd={(e) => {
              const dy = e.changedTouches[0].clientY - overlayTouchStartRef.current.y;
              const dx = e.changedTouches[0].clientX - overlayTouchStartRef.current.x;
              if (dy > 50 && Math.abs(dy) > Math.abs(dx)) setShowGameModeHelp(false);
            }}
          >
            <p className="text-base text-slate-700 leading-relaxed">
              방식을 고른 뒤 「경기 만들기」를 누르면 오늘 경기에 생깁니다.
            </p>
            <button
              type="button"
              onClick={() => setShowGameModeHelp(false)}
              className="mt-3 w-full py-3 min-h-11 rounded-full text-base font-medium bg-slate-100 text-slate-700 hover:bg-slate-200 transition-colors"
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
            className="fixed left-1/2 top-1/2 z-40 w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-3xl bg-white p-4 shadow-[0_12px_32px_rgba(47,91,160,0.16)] border border-[#e8eef6]"
            onTouchStart={(e) => { overlayTouchStartRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY }; }}
            onTouchEnd={(e) => {
              const dy = e.changedTouches[0].clientY - overlayTouchStartRef.current.y;
              const dx = e.changedTouches[0].clientX - overlayTouchStartRef.current.x;
              if (dy > 50 && Math.abs(dy) > Math.abs(dx)) setShowRecordHelp(false);
            }}
          >
            <p className="text-base text-slate-700 leading-relaxed">
              만든이는 「만들기 → 보내기 → 대진 → 점수」만 보면 됩니다. 링크를 받은 사람은 오늘 경기에 들어가서, 사람 모으는 중인지 점수 적는 중인지만 보면 됩니다.
            </p>
            <p className="mt-2 text-base text-slate-500 leading-relaxed">
              만든이가 경기를 삭제하면 다른 사람 목록에서도 사라집니다. 참여자는 목록에서만 뺍니다.
            </p>
            <button
              type="button"
              onClick={() => setShowRecordHelp(false)}
              className="mt-3 w-full py-3 min-h-11 rounded-full text-base font-medium bg-slate-100 text-slate-700 hover:bg-slate-200 transition-colors"
            >
              닫기
            </button>
          </div>
        </>
      )}

      {showWithdrawConfirm && (
        <>
          <div className="fixed inset-0 z-30 bg-black/20" aria-hidden onClick={() => setShowWithdrawConfirm(false)} />
          <div
            className="fixed left-1/2 top-1/2 z-40 w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-3xl bg-white p-4 shadow-[0_12px_32px_rgba(47,91,160,0.16)] border border-[#e8eef6]"
            onTouchStart={(e) => { overlayTouchStartRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY }; }}
            onTouchEnd={(e) => {
              const dy = e.changedTouches[0].clientY - overlayTouchStartRef.current.y;
              const dx = e.changedTouches[0].clientX - overlayTouchStartRef.current.x;
              if (dy > 50 && Math.abs(dy) > Math.abs(dx)) setShowWithdrawConfirm(false);
            }}
          >
            <p className="text-base text-slate-800 font-medium">계정을 탈퇴할까요?</p>
            <p className="mt-2 text-base text-slate-500 leading-relaxed">
              프로필, 경기 목록, 내가 만든 공유 경기가 삭제됩니다. 참여만 한 경기의 원본은 남습니다.
            </p>
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                onClick={() => setShowWithdrawConfirm(false)}
                className="flex-1 py-3 min-h-11 rounded-full text-base font-medium bg-slate-100 text-slate-700 hover:bg-slate-200 transition-colors"
              >
                취소
              </button>
              <button
                type="button"
                onClick={async () => {
                  const result = await deleteCurrentAccount();
                  if (!result.ok) {
                    setShareToast(result.message ?? "탈퇴에 실패했습니다.");
                    setTimeout(() => setShareToast(null), 4000);
                    setShowWithdrawConfirm(false);
                    return;
                  }
                  for (const id of loadGameList()) {
                    removeGameFromList(id);
                  }
                  saveGameList([]);
                  refreshListDisplay();
                  const cleared = { ...DEFAULT_MYINFO };
                  setMyInfo(cleared);
                  saveMyInfo(cleared);
                  setHasUploadedProfileAfterLogin(false);
                  setLoginGatePassed(false);
                  setAuthUid(null);
                  setPhoneStep("idle");
                  setPhoneNumberInput("");
                  setPhoneCodeInput("");
                  setPhoneError("");
                  phoneConfirmationResultRef.current = null;
                  setShowWithdrawConfirm(false);
                  setShareToast("계정을 탈퇴했습니다.");
                  setTimeout(() => setShareToast(null), 3000);
                }}
                className="flex-1 py-3 min-h-11 rounded-full text-base font-medium bg-red-600 text-white hover:bg-red-700 transition-colors"
              >
                탈퇴
              </button>
            </div>
          </div>
        </>
      )}

      <main
        ref={mainRef}
        className="flex-1 px-2 pb-24 overflow-auto scroll-smooth"
        onTouchStart={handleMainTouchStart}
        onTouchMove={handleMainTouchMove}
        onTouchEnd={handleMainTouchEnd}
      >
        {navView === "setting" && (
        <div key={`setting-${settingRefreshKey}`} className="space-y-2 pt-4 animate-panel-enter">
        {/* 경기 방식: 카테고리 탭 + 좌측 목록 + 우측 상세 (참고 이미지 구조) */}
        <section id="section-info" className="scroll-mt-2">
          <div className="rounded-3xl bg-white border border-[#e8eef6] overflow-hidden min-w-0 card-app card-app-interactive">
            {/* 상단 카테고리 탭 - 좁은 폭에서 크기 자동 보정, 균등 분배 */}
            <div className="flex border-b border-[#e8eef6] flex-nowrap min-w-0">
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
                    className={`flex-1 min-w-0 px-1.5 py-3 sm:px-2.5 text-base font-medium border-b-2 transition-colors flex items-center justify-center gap-1 sm:gap-2 ${isActive ? "border-[#0071e3] text-[#0071e3]" : "border-transparent text-slate-600 hover:text-slate-800"}`}
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
              <nav className="min-w-[4.75rem] w-[4.75rem] shrink-0 border-r border-[#e8eef6] bg-slate-50/50">
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
                          className={`w-full text-left px-1 py-3 min-h-11 text-base rounded-r border-l-2 transition-colors whitespace-nowrap ${isSelected ? "border-[#0071e3] bg-[#0071e3]/10 text-[#0071e3] font-medium" : "border-transparent text-slate-700 hover:bg-slate-100/80"}`}
                        >
                          {mode.label}
                        </button>
                      </li>
                    );
                  })}
                </ul>
                {GAME_MODES.filter((m) => (m.categoryId ?? GAME_CATEGORIES[0].id) === gameModeCategoryId).length === 0 && (
                  <p className="px-0.5 py-2 text-base text-slate-500">준비 중</p>
                )}
              </nav>
              {/* 우측: 해당 카테고리에서 선택한 경기 방식일 때만 상세 표시 */}
              <div className="flex-1 min-w-0 px-1 py-1 text-base text-[#6e6e73] space-y-1 leading-relaxed">
                {(gameMode.categoryId ?? GAME_CATEGORIES[0].id) === gameModeCategoryId ? (
                  <>
                    {gameModeId !== "individual_b" && (
                    <button
                      type="button"
                      onClick={addGameToRecord}
                      disabled={!isOnline}
                      className="w-full py-4 rounded-full text-lg font-semibold text-white bg-[#0071e3] hover:bg-[#0077ed] transition-colors mb-3 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-[#0071e3] btn-tap"
                    >
                      경기 만들기
                    </button>
                    )}
                    {gameModeId === "individual_b" && (
                      <p className="text-base text-slate-500 mb-2">개인전b는 준비 중입니다. 지금은 개인전a로 경기를 만들 수 있습니다.</p>
                    )}
                    {gameModeId === "individual" ? (
                      <div className="space-y-3">
                        <div>
                          <p className="text-base font-semibold text-[#0071e3] mb-0.5 leading-tight">특징</p>
                          <div className="space-y-0.5 text-slate-600 text-base leading-tight">
                            <p>인원에 따라 총 경기 수와 인당 경기 수가 아래 표처럼 정해져 있으며, 참가자는 모두 동일한 경기 수로 공정하게 진행합니다.</p>
                            <p>파트너와 상대를 경기마다 바꿔 가며 여러 분과 골고루 대전할 수 있습니다.</p>
                          </div>
                        </div>
                        <div>
                          <p className="text-base font-semibold text-[#0071e3] mb-0.5 leading-tight">인원</p>
                          <p className="text-slate-600 text-base leading-tight">{gameMode.minPlayers}~{gameMode.maxPlayers}명</p>
                        </div>
                        <div>
                          <p className="text-base font-semibold text-[#0071e3] mb-0.5 leading-tight">경기수·소요시간</p>
                          <div className="overflow-x-auto mt-0.5 min-w-0">
                            <table className="w-full min-w-[240px] table-auto border-collapse text-base text-slate-600 leading-tight font-numeric">
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
                          <p className="text-base font-semibold text-[#0071e3] mb-0.5 leading-tight">특징</p>
                          <p className="text-slate-600 text-base leading-tight">개인전b 전용 규칙입니다. (내용 추후 입력)</p>
                        </div>
                        <div>
                          <p className="text-base font-semibold text-[#0071e3] mb-0.5 leading-tight">인원</p>
                          <p className="text-slate-500 text-base leading-tight">추후 정의됩니다.</p>
                        </div>
                        <div>
                          <p className="text-base font-semibold text-[#0071e3] mb-0.5 leading-tight">경기수·소요시간</p>
                          <p className="text-slate-500 text-base leading-tight">개인전b 전용 표는 추후 정의됩니다.</p>
                        </div>
                      </div>
                    ) : (
                      <div className="space-y-3">
                        <div>
                          <p className="text-base font-semibold text-[#0071e3] mb-0.5 leading-tight">인원</p>
                          <p className="text-slate-600 text-base leading-tight">{gameMode.minPlayers}~{gameMode.maxPlayers}명</p>
                        </div>
                      </div>
                    )}
                  </>
                ) : (
                  <p className="text-base text-slate-500 py-8 text-center">
                    {GAME_MODES.filter((m) => (m.categoryId ?? GAME_CATEGORIES[0].id) === gameModeCategoryId).length === 0
                      ? "이 경기 방식은 준비 중입니다. 지금은 복식에서 경기를 만들 수 있습니다."
                      : "왼쪽 목록에서 경기 방식을 선택하면 상세 내용이 표시됩니다."}
                  </p>
                )}
              </div>
            </div>
          </div>
        </section>
        </div>
        )}
        {navView === "record" && (
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
              <div className="px-2 py-8 space-y-3">
                <button
                  type="button"
                  onClick={() => setNavView("setting")}
                  className="w-full py-4 rounded-full text-lg font-semibold text-white bg-[#0071e3] hover:bg-[#0077ed] transition-colors btn-tap"
                >
                  경기 만들기
                </button>
                <button
                  type="button"
                  onClick={() => setJoinLinkOpen((open) => !open)}
                  className="w-full py-4 rounded-full text-lg font-semibold text-[#0071e3] bg-white border-2 border-[#0071e3] hover:bg-[#0071e3]/5 transition-colors btn-tap"
                >
                  링크로 들어가기
                </button>
                {joinLinkOpen && (
                  <div className="space-y-2 pt-1">
                    <input
                      type="text"
                      value={joinLinkInput}
                      onChange={(e) => setJoinLinkInput(e.target.value)}
                      placeholder="받은 링크를 붙여 넣으세요"
                      className="w-full py-3 px-3 text-base rounded-xl border border-[#d2d2d7] bg-white"
                      aria-label="받은 링크"
                    />
                    <button
                      type="button"
                      onClick={() => {
                        const id = parseShareParam(joinLinkInput);
                        if (!id) {
                          setShareToast("받은 링크를 붙여 넣어 주세요.");
                          setTimeout(() => setShareToast(null), 3000);
                          return;
                        }
                        setJoinLinkOpen(false);
                        setJoinLinkInput("");
                        processShareAndOpenDetail(id);
                      }}
                      className="w-full py-3 rounded-full text-base font-semibold text-white bg-[#0071e3] hover:bg-[#0077ed] btn-tap"
                    >
                      들어가기
                    </button>
                  </div>
                )}
              </div>
            ) : (
            <>
            <ul className="space-y-2">
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
                const completedCount = data.matches.filter((m) => isRecordedScore(m)).length;
                const matchIdSet = new Set(data.matches.map((m) => String(m.id)));
                const ongoingCount = (data.playingMatchIds ?? []).filter((id) => matchIdSet.has(id)).length;
                const allDone = hasMatches && completedCount === data.matches.length;
                const rosterOut = rosterOutOfSyncWithDraw(data.members ?? [], data.matches ?? []);
                const currentStage =
                  !hasMatches
                    ? "사람 모으는 중"
                    : rosterOut
                      ? "대진 다시 필요"
                      : completedCount === 0
                        ? "대진 있음"
                        : allDone
                          ? "끝"
                          : "점수 적는 중";
                const stageHighlight: Record<string, string> = {
                  "사람 모으는 중": "bg-green-100 text-green-700 border border-green-200",
                  "대진 다시 필요": "bg-amber-100 text-amber-800 border border-amber-200",
                  "대진 있음": "bg-blue-100 text-blue-700 border border-blue-200",
                  "점수 적는 중": "bg-amber-100 text-amber-700 border border-amber-200",
                  "끝": "bg-slate-800 text-white border border-slate-700",
                };
                const tableHeaderByStage: Record<string, string> = {
                  "사람 모으는 중": "bg-green-100 text-green-700",
                  "대진 다시 필요": "bg-amber-100 text-amber-800",
                  "대진 있음": "bg-blue-100 text-blue-700",
                  "점수 적는 중": "bg-amber-100 text-amber-700",
                  "끝": "bg-slate-800 text-white",
                };
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
                      className="w-full text-left px-3 py-3 pr-10 rounded-3xl bg-white border border-[#e8eef6] hover:bg-[#f7faff] transition-all duration-200 btn-tap cursor-pointer card-app card-app-interactive"
                    >
                      {/* 1행: 경기 이름 (공간 확보, 비어 있으면 빈 줄 유지) */}
                      <p className="font-semibold text-slate-800 truncate text-base leading-tight font-numeric min-h-[1.25rem]" title={titleLabel}>{titleLabel || "\u00A0"}</p>
                      {/* 경기 요약 축약: 방식·인원·언제·어디·승점 + 만든이, 그 하단에 뱃지·테이블 */}
                      <div className="mt-0 space-y-px w-full block">
                        <p className="text-base text-slate-500 leading-tight">경기 방식: {modeLabel}</p>
                          <p className="text-base text-slate-500 leading-tight font-numeric">
                            경기 인원:{" "}
                            {(() => {
                              const drawCount = uniqueDrawPlayerCount(data.matches);
                              const count = data.matches.length > 0 ? drawCount : data.members.length;
                              const totalGames = data.matches.length > 0 ? data.matches.length : (mode && count >= mode.minPlayers && count <= mode.maxPlayers ? getTargetTotalGames(count) : 0);
                              const perPerson = count > 0 && totalGames > 0 ? Math.round((totalGames * 4) / count) : "-";
                              return <>총{count}명-총{totalGames || "-"}경기-인당{perPerson}경기</>;
                            })()}
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
                                <p className="text-base text-slate-500 leading-tight">
                                  경기 언제·어디·승점: {parts.join(" · ")}
                                </p>
                              );
                            }
                            return null;
                          })()}
                          <p className="text-base text-slate-500 leading-tight">
                            {(() => {
                              const uid = myInfo.uid ?? getCurrentUserUid();
                              const madeByMe = Boolean(uid && data.createdByUid && uid === data.createdByUid);
                              const onRoster = Boolean(uid && data.members.some((m) => m.linkedUid === uid));
                              const relation = madeByMe ? "내가 만든 경기" : onRoster ? "같이함" : "구경";
                              const relationClass = madeByMe
                                ? "bg-blue-100 text-blue-700"
                                : onRoster
                                  ? "bg-emerald-100 text-emerald-700"
                                  : "bg-slate-100 text-slate-600";
                              return (
                                <>
                                  <span className={`mr-1.5 text-base font-medium px-2 py-0.5 rounded-full leading-none ${relationClass}`}>
                                    {relation}
                                  </span>
                                  만든 이: {creatorDisplay}{dateStr ? ` ${dateStr}` : ""}
                                </>
                              );
                            })()}
                          </p>
                        {/* 신청·생성·진행·종료 뱃지 + 총/종료/진행/대기 테이블 (경기 요약 하단, 전체 너비) */}
                        <div className="w-full flex flex-col gap-0.5 pt-1">
                          <div className="flex items-center gap-1 flex-wrap">
                            <span className={`text-base font-semibold px-3 py-1 rounded-full shrink-0 leading-none ${stageHighlight[currentStage]}`}>
                              {currentStage}
                            </span>
                          </div>
                          {total > 0 && (
                            <table className="w-full max-w-[200px] text-base border border-slate-200 rounded overflow-hidden font-numeric table-fixed border-collapse">
                              <tbody>
                                <tr className={tableHeaderClass}>
                                  <th className={`py-0 px-1 text-center font-medium leading-none w-1/4 border-r ${currentStage === "끝" ? "border-slate-600" : "border-slate-200"}`}>총</th>
                                  <th className={`py-0 px-1 text-center font-medium leading-none w-1/4 border-r ${currentStage === "끝" ? "border-slate-600" : "border-slate-200"}`}>종료</th>
                                  <th className={`py-0 px-1 text-center font-medium leading-none w-1/4 border-r ${currentStage === "끝" ? "border-slate-600" : "border-slate-200"}`}>진행</th>
                                  <th className="py-0 px-1 text-center font-medium leading-none w-1/4">대기</th>
                                </tr>
                                <tr className="border-t border-[#e8eef6] bg-white text-slate-700">
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
                    {/* 카드별 ... 메뉴 (삭제·공유) */}
                    <div className="absolute top-1 right-1">
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); setListMenuOpenId((prev) => (prev === id ? null : id)); }}
                        className="w-11 h-11 flex items-center justify-center rounded text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                        aria-label="메뉴"
                        aria-expanded={isMenuOpen}
                      >
                        <span className="text-base leading-none">⋯</span>
                      </button>
                      {isMenuOpen && (
                        <>
                          <div className="fixed inset-0 z-10" aria-hidden onClick={() => setListMenuOpenId(null)} />
                          <div className="absolute right-0 top-full mt-1 py-1 min-w-[100px] rounded-2xl bg-white border border-[#e8eef6] shadow-[0_8px_24px_rgba(47,91,160,0.12)] z-20">
                            <button
                              type="button"
                              onClick={(e) => { e.stopPropagation(); handleDeleteCard(id); }}
                              className="w-full text-left px-3 py-3 min-h-11 text-base text-red-600 hover:bg-red-50 rounded-t-lg btn-tap"
                            >
                              {Boolean((myInfo.uid ?? getCurrentUserUid()) && data.createdByUid && (myInfo.uid ?? getCurrentUserUid()) === data.createdByUid)
                                ? "삭제"
                                : "목록에서 빼기"}
                            </button>
                            <button
                              type="button"
                              onClick={(e) => { e.stopPropagation(); handleShareCard(id); }}
                              className="w-full text-left px-3 py-3 min-h-11 text-base text-slate-700 hover:bg-slate-50 rounded-b-lg btn-tap"
                            >
                              카톡으로 보내기
                            </button>
                          </div>
                        </>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
            <div className="px-2 pt-4 space-y-2">
              <button
                type="button"
                onClick={() => setJoinLinkOpen((open) => !open)}
                className="w-full py-3 min-h-11 rounded-full text-base font-semibold text-[#0071e3] bg-white border-2 border-[#0071e3] hover:bg-[#0071e3]/5 btn-tap"
              >
                링크로 들어가기
              </button>
              {joinLinkOpen && (
                <div className="space-y-2">
                  <input
                    type="text"
                    value={joinLinkInput}
                    onChange={(e) => setJoinLinkInput(e.target.value)}
                    placeholder="받은 링크를 붙여 넣으세요"
                    className="w-full py-3 px-3 text-base rounded-xl border border-[#d2d2d7] bg-white"
                    aria-label="받은 링크"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      const id = parseShareParam(joinLinkInput);
                      if (!id) {
                        setShareToast("받은 링크를 붙여 넣어 주세요.");
                        setTimeout(() => setShareToast(null), 3000);
                        return;
                      }
                      setJoinLinkOpen(false);
                      setJoinLinkInput("");
                      processShareAndOpenDetail(id);
                    }}
                    className="w-full py-3 rounded-full text-base font-semibold text-white bg-[#0071e3] hover:bg-[#0077ed] btn-tap"
                  >
                    들어가기
                  </button>
                </div>
              )}
            </div>
            </>
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
                /* 저장 버튼 연타 시 state가 아직 반영 전일 수 있으므로, 로컬에 마지막 저장된 데이터(loadGame) 기준으로 payload 구성. 요약은 만든이만 반영 */
                const existing = loadGame(effectiveGameId);
                const gameNameEl = document.getElementById("game-name") as HTMLInputElement | null;
                const gameDateEl = document.getElementById("game-date") as HTMLInputElement | null;
                const gameTimeEl = document.getElementById("game-time") as HTMLSelectElement | null;
                const gameLocationEl = document.getElementById("game-location") as HTMLInputElement | null;
                const gameScoreLimitEl = document.getElementById("game-score-limit") as HTMLInputElement | null;
                const gameNameToSave = isGameSummaryEditable
                  ? (gameNameEl ? (gameNameEl.value.trim() || undefined) : (gameName.trim() || existing.gameName))
                  : existing.gameName;
                const baseSettings = existing.gameSettings ?? gameSettings;
                const dateToSave = isGameSummaryEditable
                  ? (gameDateEl ? (gameDateEl.value.trim() || gameSettings.date) : gameSettings.date)
                  : baseSettings.date;
                const timeToSave = isGameSummaryEditable
                  ? (gameTimeEl && TIME_OPTIONS_30MIN.includes(gameTimeEl.value) ? gameTimeEl.value : gameSettings.time)
                  : baseSettings.time;
                const locationToSave = isGameSummaryEditable
                  ? (gameLocationEl ? (gameLocationEl.value.trim() ?? gameSettings.location) : gameSettings.location)
                  : baseSettings.location;
                const scoreRaw = isGameSummaryEditable && gameScoreLimitEl?.value != null
                  ? parseInt(gameScoreLimitEl.value, 10)
                  : gameSettings.scoreLimit;
                const scoreLimitToSave = Number.isNaN(scoreRaw) ? 21 : Math.max(1, Math.min(99, scoreRaw));
                const membersToSave = hasSavedScore
                  ? (existing.members ?? [])
                  : applyMyProfileToMembers(existing.members ?? [], myProfileMemberId, myProfileForMembers);
                const payload = buildGameDataPayload(existing, {
                  members: membersToSave,
                  matches: existing.matches ?? [],
                  gameName: gameNameToSave,
                  gameMode: gameModeId,
                  gameSettings: { ...baseSettings, date: dateToSave, time: timeToSave, location: locationToSave, scoreLimit: scoreLimitToSave },
                  myProfileMemberId: myProfileMemberId ?? undefined,
                  playingMatchIds: selectedPlayingMatchIds,
                  playingUpdatedAt,
                });
                saveGame(effectiveGameId, payload);
                if (typeof navigator !== "undefined" && navigator.onLine) {
                  uploadSharedGameIfNeeded(payload)
                    .then((result) => applySharedWriteResult(result, payload, setLastFirestoreUploadBytes, setShareToast))
                    .catch(() => {});
                } else {
                  setShareToast("저장되었습니다. 네트워크 연결 후 동기화됩니다.");
                  setTimeout(() => setShareToast(null), 3000);
                }
                setRecordDetailClosing(true);
                setTimeout(() => {
                  setSelectedGameId(null);
                  setRecordDetailClosing(false);
                }, 250);
              }}
              disabled={recordDetailClosing}
              className="inline-flex items-center min-h-11 text-base font-medium text-[#0071e3] hover:underline disabled:opacity-70 disabled:pointer-events-none"
            >
              ← 목록으로
            </button>
          </div>
          <div className="flex items-center justify-around rounded-3xl bg-white border border-[#e8eef6] px-1 py-1 mb-1">
            {([
              { id: "people" as const, label: "사람" },
              { id: "draw" as const, label: "대진" },
              { id: "score" as const, label: "점수" },
            ]).map((s) => {
              const locked = s.id !== "people" && matches.length === 0;
              const active = detailStep === s.id;
              return (
                <button
                  key={s.id}
                  type="button"
                  disabled={locked}
                  onClick={() => {
                    if (!locked) setDetailStep(s.id);
                  }}
                  className={`flex-1 py-3 text-lg font-semibold rounded-xl btn-tap ${active ? "text-[#0071e3]" : locked ? "text-slate-300" : "text-slate-500"}`}
                >
                  {s.label}{active ? " ●" : ""}
                </button>
              );
            })}
          </div>

          {detailStep === "people" && (
          <>
          {/* 경기 요약 카드 */}
          <div className="rounded-3xl bg-white border border-[#e8eef6] overflow-hidden mt-2 card-app card-app-interactive">
            <div className="px-4 py-0.5 border-b border-[#e8eef6] flex items-center justify-between gap-2">
              <h3 className="text-lg font-semibold text-slate-800 leading-tight">경기 요약</h3>
              {!isGameSummaryEditable && <span className="text-base text-slate-400">만든이만 수정 가능</span>}
            </div>
            <div className="px-4 py-0.5 space-y-px">
              <div className="flex items-center gap-0.5 py-0.5">
                <label htmlFor="game-name" className="text-base font-medium text-slate-600 shrink-0 w-20">경기 이름</label>
                <input
                  id="game-name"
                  type="text"
                  value={gameName}
                  onChange={(e) => setGameName(e.target.value)}
                  onFocus={() => { gameSummaryFocusedRef.current = true; }}
                  onBlur={() => { gameSummaryFocusedRef.current = false; }}
                  placeholder="경기 이름 입력"
                  disabled={!isGameSummaryEditable}
                  className="flex-1 min-w-0 px-2 py-0.5 rounded-lg border border-[#d2d2d7] bg-[#fbfbfd] text-[#1d1d1f] placeholder:text-[#6e6e73] text-base focus:outline-none focus:ring-2 focus:ring-[#0071e3]/25 focus:border-[#0071e3] disabled:opacity-70 disabled:cursor-not-allowed"
                  aria-label="경기 이름"
                />
              </div>
              <div className="flex items-center gap-0.5 py-0.5">
                <span className="text-base font-medium text-slate-600 shrink-0 w-20">경기 방식</span>
                <span className="flex-1 text-base font-medium text-slate-500 bg-slate-100 px-2 py-0.5 rounded-lg border border-slate-200 cursor-default select-none" title="경기 방식에서 선택한 값 (변경 불가)">
                  {gameMode.label}
                </span>
              </div>
              <div className="flex items-center gap-0.5 py-0.5">
                <span className="text-base font-medium text-slate-600 shrink-0 w-20">경기 인원</span>
                <span className="flex-1 text-base font-medium text-slate-500 font-numeric bg-slate-100 px-2 py-0.5 rounded-lg border border-slate-200 cursor-default select-none inline-block" title="경기 명단 인원 기준 (변경 불가)">
                  {members.length >= gameMode.minPlayers && members.length <= gameMode.maxPlayers ? (
                    <>총{members.length}명-총{getTargetTotalGames(members.length)}경기-인당{getTargetTotalGames(members.length) > 0 ? Math.round((getTargetTotalGames(members.length) * 4) / members.length) : "-"}경기</>
                  ) : (
                    <>총{members.length}명-총-경기-인당-경기</>
                  )}
                </span>
              </div>
              <div className="flex items-center gap-0.5 py-0.5">
                <label htmlFor="game-date" className="text-base font-medium text-slate-600 shrink-0 w-20">경기 언제</label>
                <input
                  id="game-date"
                  type="date"
                  value={gameSettings.date}
                  onChange={(e) => setGameSettings((s) => ({ ...s, date: e.target.value }))}
                  onFocus={() => { gameSummaryFocusedRef.current = true; }}
                  onBlur={() => { gameSummaryFocusedRef.current = false; }}
                  disabled={!isGameSummaryEditable}
                  className="flex-1 min-w-0 px-2 py-0.5 rounded-lg border border-[#d2d2d7] bg-[#fbfbfd] text-[#1d1d1f] text-base focus:outline-none focus:ring-2 focus:ring-[#0071e3]/25 focus:border-[#0071e3] focus:border-blue-400 disabled:opacity-70 disabled:cursor-not-allowed"
                  aria-label="날짜"
                />
                <select
                  id="game-time"
                  value={TIME_OPTIONS_30MIN.includes(gameSettings.time) ? gameSettings.time : TIME_OPTIONS_30MIN[0]}
                  onChange={(e) => setGameSettings((s) => ({ ...s, time: e.target.value }))}
                  onFocus={() => { gameSummaryFocusedRef.current = true; }}
                  onBlur={() => { gameSummaryFocusedRef.current = false; }}
                  disabled={!isGameSummaryEditable}
                  className="w-24 px-2 py-0.5 rounded-lg border border-[#d2d2d7] bg-[#fbfbfd] text-[#1d1d1f] text-base focus:outline-none focus:ring-2 focus:ring-[#0071e3]/25 focus:border-[#0071e3] focus:border-blue-400 disabled:opacity-70 disabled:cursor-not-allowed"
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
                <label htmlFor="game-location" className="text-base font-medium text-slate-600 shrink-0 w-20">경기 어디</label>
                <input
                  id="game-location"
                  type="text"
                  value={gameSettings.location}
                  onChange={(e) => setGameSettings((s) => ({ ...s, location: e.target.value }))}
                  onFocus={() => { gameSummaryFocusedRef.current = true; }}
                  onBlur={() => { gameSummaryFocusedRef.current = false; }}
                  placeholder="장소 입력"
                  disabled={!isGameSummaryEditable}
                  className="flex-1 min-w-0 px-2 py-0.5 rounded-lg border border-[#d2d2d7] bg-[#fbfbfd] text-[#1d1d1f] placeholder:text-[#6e6e73] text-base focus:outline-none focus:ring-2 focus:ring-[#0071e3]/25 focus:border-[#0071e3] disabled:opacity-70 disabled:cursor-not-allowed"
                  aria-label="장소"
                />
              </div>
              <div className="flex items-center gap-0.5 py-0.5">
                <label htmlFor="game-score-limit" className="text-base font-medium text-slate-600 shrink-0 w-20">경기 승점</label>
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
                  disabled={!isGameSummaryEditable}
                  className="flex-1 min-w-0 w-20 px-2 py-0.5 rounded-lg border border-[#d2d2d7] bg-[#fbfbfd] text-[#1d1d1f] text-base focus:outline-none focus:ring-2 focus:ring-[#0071e3]/25 focus:border-[#0071e3] focus:border-blue-400 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none disabled:opacity-70 disabled:cursor-not-allowed"
                  aria-label="한 경기당 득점 제한 (직접 입력)"
                />
                <span className="text-base text-slate-500 shrink-0">점</span>
              </div>
            </div>
          </div>

          {/* 경기 명단 카드 - 报名名单 스타일 */}
          <div id="section-members" className="rounded-3xl bg-white border border-[#e8eef6] overflow-hidden mt-2 scroll-mt-2 card-app card-app-interactive">
            <div className="px-2 py-1.5 border-b border-[#e8eef6] flex items-center justify-between">
              <div>
                <h3 className="text-lg font-semibold text-slate-800">경기 명단</h3>
                <p className="text-base text-slate-600 mt-1">
                  {hasSavedScore
                    ? "점수가 있으면 명단을 바꾸지 않습니다."
                    : "이름을 넣고, 카톡으로 보내 사람을 모으세요."}
                </p>
              </div>
              <span className="shrink-0 px-1.5 py-0.5 rounded-full text-base font-medium bg-slate-100 text-slate-600 border border-slate-200">
                {members.length}명
              </span>
            </div>
            <div className="w-full overflow-x-auto">
              <table className="w-full border-collapse border border-slate-300 text-left">
                <thead>
                  <tr className="bg-slate-100">
                    <th className="border-l border-slate-300 first:border-l-0 px-1 py-0 text-base font-semibold text-slate-700 w-10">번호</th>
                    <th className="border-l border-slate-300 px-1 py-0 text-base font-semibold text-slate-700 min-w-[6rem] w-32">프로필</th>
                    <th className="border-l border-slate-300 px-1 py-0 text-base font-semibold text-slate-700 min-w-[3rem] w-14">삭제</th>
                  </tr>
                </thead>
                <tbody>
                  {members.map((m, i) => (
                    <tr key={m.id} className="bg-slate-50 even:bg-white">
                      <td className="border-l border-slate-300 first:border-l-0 px-1 py-0 align-middle">
                        <span className="inline-block text-base leading-tight">{String(i + 1).padStart(2, "0")}</span>
                      </td>
                      <td className="border-l border-slate-300 px-1 py-0 align-middle text-base font-medium text-slate-800 whitespace-nowrap min-w-0 leading-tight">
                        <span className="tracking-tighter inline-flex items-center gap-0" style={{ letterSpacing: "-0.02em" }}>
                          {m.name}
                          <span className="inline-flex items-center gap-0 text-base leading-none origin-left" style={{ letterSpacing: "-0.08em", color: m.gender === "F" ? "#e8a4bc" : "#7c9fd8", transform: "scale(0.5)", transformOrigin: "left center" }}>
                            <span className="inline-block">{m.gender === "F" ? "\u2640\uFE0F" : "\u2642\uFE0F"}</span>
                            <span className="inline-block leading-none align-middle text-black">{m.grade}</span>
                          </span>
                        </span>
                      </td>
                      <td className="border-l border-slate-300 px-1 py-0 align-middle">
                        {!hasSavedScore && (isGameOwner || Boolean((myInfo.uid ?? getCurrentUserUid()) && m.linkedUid && (myInfo.uid ?? getCurrentUserUid()) === m.linkedUid)) ? (
                        <button
                          type="button"
                          onClick={() => removeMember(m.id)}
                          className="w-10 h-10 flex items-center justify-center text-base text-slate-500 hover:bg-red-100 hover:text-red-600"
                          aria-label={`${m.name} 제거`}
                        >
                          ×
                        </button>
                        ) : (
                          <span className="inline-block w-10 h-10" />
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {isGameOwner && !hasSavedScore && (
            <div className="border-t border-[#e8eef6] px-2 py-2">
              <div className="flex flex-row items-center gap-1.5 flex-nowrap overflow-hidden">
                <span className="text-base font-medium text-slate-600 shrink-0 whitespace-nowrap">인원 추가</span>
                <input
                  type="text"
                  value={newMemberName}
                  onChange={(e) => setNewMemberName(e.target.value)}
                  placeholder="이름"
                  aria-label="이름"
                  className="flex-1 min-w-0 h-11 px-2 py-0 text-base rounded-lg border border-[#d2d2d7] bg-[#fbfbfd] text-[#1d1d1f] placeholder:text-[#6e6e73] focus:outline-none focus:ring-2 focus:ring-[#0071e3]/25 focus:border-[#0071e3] box-border"
                />
                <select
                  value={newMemberGender}
                  onChange={(e) => setNewMemberGender(e.target.value as "M" | "F")}
                  aria-label="성별"
                  className="shrink-0 w-14 h-11 px-1.5 py-0 text-base rounded-lg border border-[#d2d2d7] bg-[#fbfbfd] text-[#1d1d1f] focus:outline-none focus:ring-2 focus:ring-[#0071e3]/25 focus:border-[#0071e3]"
                >
                  <option value="M">남</option>
                  <option value="F">여</option>
                </select>
                <select
                  value={newMemberGrade}
                  onChange={(e) => setNewMemberGrade(e.target.value as Grade)}
                  aria-label="급수"
                  className="shrink-0 w-12 h-11 px-1.5 py-0 text-base rounded-lg border border-[#d2d2d7] bg-[#fbfbfd] text-[#1d1d1f] focus:outline-none focus:ring-2 focus:ring-[#0071e3]/25 focus:border-[#0071e3]"
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
                  className="shrink-0 h-11 px-3 rounded-full text-base font-medium text-white bg-[#0071e3] hover:bg-[#0077ed] transition-colors btn-tap whitespace-nowrap"
                >
                  추가
                </button>
              </div>
            </div>
            )}
            <div className="border-t border-[#e8eef6] px-2 py-3 space-y-2">
              {!isOnRoster && !hasSavedScore && (
              <button
                type="button"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  const name = myInfo.name?.trim();
                  if (!name) {
                    alert("나의 정보에서 이름을 먼저 넣어 주세요.");
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
                  if (effectiveGameId != null) {
                    enrollGameInMyList(effectiveGameId);
                  }
                }}
                className="w-full py-3 min-h-11 rounded-full text-base font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 transition-colors btn-tap"
              >
                나도 넣기
              </button>
              )}
              {effectiveGameId != null && (
              <button
                type="button"
                onClick={() => handleShareCard(effectiveGameId)}
                className={`w-full py-4 rounded-full text-lg font-semibold btn-tap ${
                  isGameOwner && matches.length === 0 && members.length >= gameMode.minPlayers && members.length <= gameMode.maxPlayers && !hasSavedScore
                    ? "text-[#0071e3] bg-white border-2 border-[#0071e3]"
                    : "text-white bg-[#0071e3] hover:bg-[#0077ed]"
                }`}
              >
                카톡으로 보내기
              </button>
              )}
              {isGameOwner && matches.length === 0 && (
              <button
                type="button"
                disabled={members.length < gameMode.minPlayers || members.length > gameMode.maxPlayers || hasSavedScore}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  if (members.length < gameMode.minPlayers || members.length > gameMode.maxPlayers) {
                    setShareToast(`인원은 ${gameMode.minPlayers}~${gameMode.maxPlayers}명이어야 합니다.`);
                    setTimeout(() => setShareToast(null), 3000);
                    return;
                  }
                  if (hasSavedScore) {
                    setShareToast("점수가 있으면 명단과 대진을 바꾸지 않습니다.");
                    setTimeout(() => setShareToast(null), 3000);
                    return;
                  }
                  doMatch();
                }}
                className="w-full py-4 rounded-full text-lg font-semibold text-white bg-[#0071e3] hover:bg-[#0077ed] btn-tap disabled:opacity-50 disabled:pointer-events-none disabled:cursor-not-allowed"
              >
                대진 만들기
              </button>
              )}
              {rosterOutOfSync && !hasSavedScore && matches.length > 0 && (
                <p className="text-base text-amber-800 text-center">늦게 들어온 사람이 있습니다. 대진에서 다시 만드세요.</p>
              )}
              {members.length < gameMode.minPlayers && (
                <p className="text-base text-slate-500 text-center">아직 {gameMode.minPlayers}명이 안 됐습니다.</p>
              )}
              {members.length > gameMode.maxPlayers && (
                <p className="text-base text-slate-500 text-center">인원은 {gameMode.maxPlayers}명까지입니다.</p>
              )}
            </div>
          </div>
          </>
          )}

          {detailStep === "draw" && (
          <>
          {isGameOwner && rosterOutOfSync && !hasSavedScore && matches.length > 0 && (
            <div className="rounded-3xl bg-amber-50 border border-amber-200 px-3 py-3 space-y-2">
              <p className="text-base text-amber-900 text-center">늦게 들어온 사람이 있습니다.</p>
              <button
                type="button"
                onClick={() => setShowRegenerateConfirm(true)}
                className="w-full py-4 rounded-full text-lg font-semibold text-white bg-[#0071e3] hover:bg-[#0077ed] btn-tap"
              >
                대진 다시 만들기
              </button>
            </div>
          )}
          {isGameOwner && matches.length > 0 && !rosterOutOfSync && !hasSavedScore && rosterChangedSinceGenerate && (
            <button
              type="button"
              onClick={() => setShowRegenerateConfirm(true)}
              className="w-full py-4 rounded-full text-lg font-semibold text-[#0071e3] bg-white border-2 border-[#0071e3] btn-tap"
            >
              대진 다시 만들기
            </button>
          )}
          </>
          )}

          {(detailStep === "draw" || detailStep === "score") && (
          <>
          {detailStep === "score" && rosterOutOfSync && (
            <p className="text-base text-amber-800 text-center px-2 py-2">대진을 다시 만든 뒤에 점수를 적을 수 있습니다.</p>
          )}
          {detailStep === "score" && !isOnRoster && !rosterOutOfSync && (
            <p className="text-base text-slate-600 text-center px-2 py-2">명단에 있어야 점수를 적을 수 있습니다.</p>
          )}
          {/* 매치 목록 - 1줄씩 */}
          <section id="section-matches" className="scroll-mt-2">
          {matches.length > 0 && (
            <div className="rounded-3xl bg-white border border-[#e8eef6] overflow-hidden mt-2 card-app card-app-interactive">
              <div className="px-2 py-1.5 border-b border-[#e8eef6]">
                <h3 className="text-lg font-semibold text-slate-800">{detailStep === "score" ? "점수" : "대진표"}</h3>
                {detailStep === "score" && (() => {
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
                    <p className="text-base text-slate-500 mt-0.5">
                      <span className="font-numeric">총{memberCount}명-총{matches.length}경기-인당{perPerson}경기</span>
                    </p>
                  );
                })()}
              </div>
              {detailStep === "score" && (
              <div className="px-2 py-1 border-b border-[#e8eef6]">
                {/* 총 / 종료 / 진행 / 대기 테이블 */}
                {(() => {
                  const total = matches.length;
                  const completedCount = matches.filter((m) => isRecordedScore(m)).length;
                  const ongoingCount = playingMatches.length;
                  const waitingCount = total - completedCount - ongoingCount;
                  const pct = (n: number) => (total ? Math.round((n / total) * 100) : 0);
                  return (
                    <table className="w-full text-base border border-slate-200 rounded overflow-hidden font-numeric table-fixed border-collapse">
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
                  <p className="text-base text-slate-500 mt-1">
                    진행을 다시 누르면 해제됩니다. 가능 {playableMatches.length}경기
                  </p>
                )}
              </div>
              )}
              <div className="divide-y divide-slate-100">
                {matches.map((m, index) => {
                  const isDone = isRecordedScore(m);
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
                  const canSelect = detailStep === "score" && !isDone && canRecordScores;
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
                    <div className={`flex flex-nowrap items-center gap-x-1 text-base overflow-x-auto ${isCurrent ? "hover:bg-amber-50/70" : ""}`}>
                    <span className="shrink-0 text-base font-semibold text-slate-600 min-w-[1.25rem]">
                      {String(index + 1).padStart(2, "0")}
                    </span>
                    <button
                      type="button"
                      onClick={() => canSelect && togglePlayingMatch(m.id)}
                      title={canSelect ? (isCurrent ? "진행 해제" : "진행으로 선택") : undefined}
                      className={`shrink-0 min-w-[2rem] px-1 py-0.5 rounded text-base font-medium flex flex-row items-center justify-center gap-0 leading-none ${statusColor} ${canSelect ? "cursor-pointer hover:opacity-80" : "cursor-default"}`}
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
                            className={`block w-full text-left text-base leading-none truncate rounded px-0.5 -mx-0.5 font-medium text-slate-700 hover:bg-slate-100 ${highlightMemberId && !isHighlight ? "opacity-90" : ""}`}
                            title={isHighlight ? "클릭 시 하이라이트 해제" : `${p.name} 클릭 시 이 선수 경기만 하이라이트 (같은 줄 왼쪽=파트너, 오른쪽=상대)`}
                          >
                            <span className={`tracking-tighter inline-flex items-center gap-0 truncate text-base ${isHighlight ? "bg-amber-400 text-amber-900 font-bold ring-1 ring-amber-500 rounded px-0.5" : ""}`} style={{ letterSpacing: "-0.02em" }}>
                              {p.name}
                              <span className="inline-flex items-center gap-0 text-base leading-none origin-left" style={{ letterSpacing: "-0.08em", color: p.gender === "F" ? "#e8a4bc" : "#7c9fd8", transform: "scale(0.5)", transformOrigin: "left center" }}>
                                <span className="inline-block">{p.gender === "F" ? "\u2640\uFE0F" : "\u2642\uFE0F"}</span>
                                <span className="inline-block leading-none align-middle text-black">{p.grade}</span>
                              </span>
                            </span>
                          </button>
                        );
                      })}
                    </div>
                    <div className="shrink-0 min-w-[3.5rem] flex items-center justify-center">
                      {detailStep === "score" ? (
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
                          disabled={!canRecordScores}
                          className="w-11 h-10 rounded-lg border border-slate-200 bg-slate-50 text-slate-800 text-center text-lg font-semibold font-numeric focus:outline-none focus:ring-1 focus:ring-blue-200 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none disabled:opacity-60"
                          aria-label="팀1 득점"
                          title={`0~${scoreLimit}점 (경기 설정 기준)`}
                        />
                        <span className="text-slate-400 text-lg font-medium px-0.5">:</span>
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
                          disabled={!canRecordScores}
                          className="w-11 h-10 rounded-lg border border-slate-200 bg-slate-50 text-slate-800 text-center text-lg font-semibold font-numeric focus:outline-none focus:ring-1 focus:ring-blue-200 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none disabled:opacity-60"
                          aria-label="팀2 득점"
                          title={`0~${scoreLimit}점 (경기 설정 기준)`}
                        />
                      </div>
                      ) : (
                        <span className="text-base font-numeric text-slate-500">
                          {isDone ? `${m.score1 ?? 0}:${m.score2 ?? 0}` : "vs"}
                        </span>
                      )}
                    </div>
                    <div className="min-w-0 flex-1 flex flex-col justify-center text-right max-w-[5.5rem] gap-0 overflow-hidden">
                      {m.team2.players.map((p) => {
                        const isHighlight = p.id === highlightMemberId;
                        return (
                          <button
                            key={p.id}
                            type="button"
                            onClick={() => setHighlightMemberId((prev) => (prev === p.id ? null : p.id))}
                            className={`block w-full text-right text-base leading-none truncate rounded px-0.5 -mx-0.5 font-medium text-slate-700 hover:bg-slate-100 ${highlightMemberId && !isHighlight ? "opacity-90" : ""}`}
                            title={isHighlight ? "클릭 시 하이라이트 해제" : `${p.name} 클릭 시 이 선수 경기만 하이라이트 (같은 줄 왼쪽=파트너, 오른쪽=상대)`}
                          >
                            <span className={`tracking-tighter inline-flex items-center gap-0 truncate text-base justify-end ${isHighlight ? "bg-amber-400 text-amber-900 font-bold ring-1 ring-amber-500 rounded px-0.5" : ""}`} style={{ letterSpacing: "-0.02em" }}>
                              {p.name}
                              <span className="inline-flex items-center gap-0 text-base leading-none origin-left" style={{ letterSpacing: "-0.08em", color: p.gender === "F" ? "#e8a4bc" : "#7c9fd8", transform: "scale(0.5)", transformOrigin: "left center" }}>
                                <span className="inline-block">{p.gender === "F" ? "\u2640\uFE0F" : "\u2642\uFE0F"}</span>
                                <span className="inline-block leading-none align-middle text-black">{p.grade}</span>
                              </span>
                            </span>
                          </button>
                        );
                      })}
                    </div>
                    {detailStep === "score" && (
                    <button
                      type="button"
                      onClick={() => saveResult(m.id)}
                      disabled={!canRecordScores}
                      className="shrink-0 min-w-[3.5rem] min-h-11 px-2 py-3 rounded-full text-base font-semibold leading-none text-white bg-[#0071e3] hover:bg-[#0077ed] transition-colors flex flex-row items-center justify-center disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      저장
                    </button>
                    )}
                    </div>
                    {detailStep === "score" && hasInfoLine && (
                      <p className="text-base text-slate-500 pl-10 leading-tight flex items-center gap-1.5 flex-wrap" title={lastSaved ? new Date(lastSaved.at).toLocaleString("ko-KR") : ""}>
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

        {detailStep === "score" && (
        <>
        {/* 경기 결과(랭킹) 카드 */}
        <section id="section-ranking" className="scroll-mt-2">
          <div className="rounded-3xl bg-white border border-[#e8eef6] overflow-hidden card-app card-app-interactive">
            <div className="px-2 py-1.5 border-b border-[#e8eef6]">
              <h3 className="text-lg font-semibold text-slate-800">경기 결과</h3>
              <p className="text-base text-slate-500 mt-0.5">경기 현황에서 진행한 경기 점수로 산출됩니다. 승수·득실차·급수 순으로 정렬됩니다.</p>
            </div>
            {matches.length === 0 ? (
              <p className="px-2 py-4 text-base text-slate-500 text-center">점수를 적으면 여기에 순위가 나옵니다.</p>
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
                        <span className="text-base font-medium text-slate-800">{rank}</span>
                      )}
                    </span>
                    <div className="flex-1 min-w-0 flex items-center gap-0 leading-tight">
                      <span className="tracking-tighter inline-flex items-center gap-0 font-medium text-slate-800 text-base" style={{ letterSpacing: "-0.02em" }}>
                        {m.name}
                        <span className="inline-flex items-center gap-0 text-base leading-none origin-left" style={{ letterSpacing: "-0.08em", color: m.gender === "F" ? "#e8a4bc" : "#7c9fd8", transform: "scale(0.5)", transformOrigin: "left center" }}>
                          <span className="inline-block">{m.gender === "F" ? "\u2640\uFE0F" : "\u2642\uFE0F"}</span>
                          <span className="inline-block leading-none align-middle text-black">{m.grade}</span>
                        </span>
                      </span>
                    </div>
                    <div className="text-right text-base text-slate-600 leading-tight">
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
        </>
        )}
          </>
          )}

        </div>
        </div>
        )}
        </div>
        )}
        {navView === "myinfo" && (
          <div key="myinfo" className="pt-4 space-y-2 animate-panel-enter">
            {!isProfileComplete && (
              <p className="text-base text-slate-600 px-1">이름과 생년월일을 저장하면 경기를 이용할 수 있습니다.</p>
            )}
            {/* 로그인 상태: 전화번호 + 로그아웃 */}
            {loginGatePassed ? (
              <div className="rounded-3xl bg-white border border-[#e8eef6] overflow-hidden card-app card-app-interactive">
                <div className="px-3 py-3 space-y-3">
                  <p className="text-base text-slate-500">
                    로그인: 전화번호 ({getCurrentPhoneUser()?.phoneNumber || myInfo.phoneNumber || ""})
                  </p>
                  <button
                    type="button"
                    onClick={handleSignOut}
                    className="w-full px-4 py-3 min-h-11 rounded-full text-base font-medium bg-slate-100 text-slate-700 hover:bg-slate-200 transition-colors btn-tap"
                  >
                    로그아웃
                  </button>
                </div>
              </div>
            ) : null}

            {/* 인사 카드. 발견 메뉴·아바타 꾸미기는 없음 */}
            {loginGatePassed && (
              <div className="rounded-3xl bg-white border border-[#e8eef6] overflow-hidden card-app card-app-interactive">
                <div className="px-4 py-4">
                  <p className="text-base text-slate-500">안녕하세요</p>
                  <div className="flex items-center gap-2 mt-1">
                    <p className="min-w-0 flex-1 text-lg font-semibold text-slate-800 truncate">
                      <span className="tracking-tighter inline-flex items-center gap-0" style={{ letterSpacing: "-0.02em" }}>
                        {myInfo.name || "이름 없음"}
                        <span className="inline-flex items-center gap-0 text-base leading-none origin-left" style={{ letterSpacing: "-0.08em", color: myInfo.gender === "F" ? "#e8a4bc" : "#7c9fd8", transform: "scale(0.5)", transformOrigin: "left center" }}>
                          <span className="inline-block">{myInfo.gender === "F" ? "\u2640\uFE0F" : "\u2642\uFE0F"}</span>
                          <span className="inline-block leading-none align-middle text-black">{myInfo.grade ?? "D"}</span>
                        </span>
                      </span>
                    </p>
                    <button
                      type="button"
                      onClick={() => setProfileEditOpen(true)}
                      className="shrink-0 px-3 py-3 min-h-11 rounded-full text-base font-medium text-[#0071e3] bg-white border-2 border-[#0071e3] hover:bg-[#0071e3]/5 transition-colors btn-tap"
                    >
                      프로필 수정
                    </button>
                  </div>
                </div>
              </div>
            )}

            <div className="rounded-3xl bg-white border border-[#e8eef6] overflow-hidden card-app card-app-interactive">
              <div className="px-2 py-2 space-y-4">
                <div>
                  <h3 className="text-lg font-semibold text-slate-700 mb-1.5">나의 전적</h3>
                  <hr className="border-t border-slate-200 my-2" aria-hidden />
                  <p className="text-slate-500 text-base py-2">각 경기의 결과 순위에서 확인합니다.</p>
                </div>
              </div>
            </div>

            <div className="rounded-3xl bg-white border border-[#e8eef6] overflow-hidden card-app card-app-interactive">
              <div className="px-3 py-3 space-y-2">
                <h3 className="text-lg font-semibold text-slate-800">사용법</h3>
                <ul className="text-base text-slate-600 leading-relaxed list-disc pl-5 space-y-2">
                  <li>오늘 경기에서 「경기 만들기」를 누르거나, 받은 링크로 들어갑니다.</li>
                  <li>사람 화면에서 「카톡으로 보내기」로 모으고, 인원이 되면 「대진 만들기」를 누릅니다.</li>
                  <li>대진이 생기면 점수를 적습니다. 막히면 짧은 안내만 나옵니다.</li>
                </ul>
              </div>
            </div>

            <div className="rounded-3xl bg-white border border-[#e8eef6] overflow-hidden card-app card-app-interactive">
              <div className="px-3 py-3 space-y-2">
                <h3 className="text-lg font-semibold text-slate-800">문의</h3>
                <a href={`mailto:${CONTACT_EMAIL}`} className="text-base text-[#0071e3] hover:underline break-all">
                  {CONTACT_EMAIL}
                </a>
              </div>
            </div>

            {loginGatePassed ? (
              <div className="rounded-3xl bg-white border border-[#e8eef6] overflow-hidden card-app card-app-interactive">
                <div className="px-3 py-3 space-y-2">
                  <h3 className="text-lg font-semibold text-slate-800">계정</h3>
                  <p className="text-base text-slate-500">탈퇴하면 이 계정의 프로필, 경기 목록, 내가 만든 공유 경기가 삭제됩니다.</p>
                  <button
                    type="button"
                    onClick={() => setShowWithdrawConfirm(true)}
                    className="w-full px-4 py-3 min-h-11 rounded-full text-base font-medium bg-red-50 text-red-700 hover:bg-red-100 transition-colors btn-tap"
                  >
                    계정 탈퇴
                  </button>
                </div>
              </div>
            ) : null}

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
          <header className="flex items-center gap-2 shrink-0 px-3 py-3 border-b border-[#e8eef6] bg-[#f7faff]">
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
              className="flex items-center gap-1 px-2 py-3 min-h-11 rounded-full text-base font-medium text-slate-700 hover:bg-slate-100 transition-colors btn-tap disabled:opacity-70 disabled:pointer-events-none"
              aria-label="뒤로가기"
            >
              <span aria-hidden>←</span>
              <span>뒤로가기</span>
            </button>
            <h2 className="text-lg font-semibold text-slate-800 flex-1 text-center pr-12">프로필 수정</h2>
          </header>
          <div className="flex-1 min-h-0 overflow-y-auto scrollbar-hide-y px-2.5 py-3 space-y-2" data-scrollbar-hide style={{ scrollbarWidth: "none", msOverflowStyle: "none" }}>
            <div className="grid gap-1.5">
              <div className="flex items-center gap-1.5">
                <label className="text-base font-medium text-slate-600 shrink-0 w-28">이름</label>
                <input
                  type="text"
                  value={myInfo.name}
                  onChange={(e) => {
                    const next = { ...myInfo, name: e.target.value };
                    setMyInfo(next);
                    saveMyInfo(next);
                  }}
                  placeholder="이름"
                  className="flex-1 min-w-0 px-2 py-3 rounded-lg border border-[#d2d2d7] bg-[#fbfbfd] text-[#1d1d1f] text-base focus:outline-none focus:ring-2 focus:ring-[#0071e3]/25 focus:border-[#0071e3]"
                  aria-label="이름"
                />
              </div>
              <div className="flex items-center gap-1.5">
                <label className="text-base font-medium text-slate-600 shrink-0 w-28">성별</label>
                <select
                  value={myInfo.gender}
                  onChange={(e) => {
                    const next = { ...myInfo, gender: e.target.value as "M" | "F" };
                    setMyInfo(next);
                    saveMyInfo(next);
                  }}
                  className="flex-1 min-w-0 px-2 py-3 rounded-lg border border-[#d2d2d7] bg-[#fbfbfd] text-base focus:outline-none focus:ring-2 focus:ring-[#0071e3]/25"
                  aria-label="성별"
                >
                  <option value="M">남</option>
                  <option value="F">여</option>
                </select>
              </div>
              <div className="flex items-center gap-1.5">
                <label className="text-base font-medium text-slate-600 shrink-0 w-28">급수</label>
                <select
                  value={myInfo.grade ?? "D"}
                  onChange={(e) => {
                    const next = { ...myInfo, grade: e.target.value as Grade };
                    setMyInfo(next);
                    saveMyInfo(next);
                  }}
                  className="flex-1 min-w-0 px-2 py-3 rounded-lg border border-[#d2d2d7] bg-[#fbfbfd] text-base focus:outline-none focus:ring-2 focus:ring-[#0071e3]/25"
                  aria-label="급수"
                >
                  <option value="A">A</option>
                  <option value="B">B</option>
                  <option value="C">C</option>
                  <option value="D">D</option>
                </select>
              </div>
              <div className="flex items-center gap-1.5">
                <label className="text-base font-medium text-slate-600 shrink-0 w-28">전화번호</label>
                <input
                  type="tel"
                  value={myInfo.phoneNumber ?? getCurrentPhoneUser()?.phoneNumber ?? ""}
                  readOnly
                  placeholder="로그인 전화번호"
                  className="flex-1 min-w-0 px-2 py-3 rounded-lg border border-[#d2d2d7] bg-slate-100 text-[#1d1d1f] text-base cursor-default"
                  aria-label="전화번호"
                  title="로그인에 사용한 전화번호입니다."
                />
              </div>
              <div className="flex items-center gap-1.5">
                <label className="text-base font-medium text-slate-600 shrink-0 w-28">생년월일</label>
                <input
                  type="date"
                  value={myInfo.birthDate ?? ""}
                  onChange={(e) => {
                    const next = { ...myInfo, birthDate: e.target.value || undefined };
                    setMyInfo(next);
                    saveMyInfo(next);
                  }}
                  className="flex-1 min-w-0 px-2 py-3 rounded-lg border border-[#d2d2d7] bg-[#fbfbfd] text-[#1d1d1f] text-base focus:outline-none focus:ring-2 focus:ring-[#0071e3]/25 focus:border-[#0071e3]"
                  aria-label="생년월일"
                />
              </div>
              <div className="flex items-center gap-1.5 mt-2">
                <span className="shrink-0 w-28" />
                <button
                  type="button"
                  onClick={uploadProfileToFirestore}
                  className="shrink-0 px-3 py-3 min-h-11 rounded-full text-base font-medium bg-[#0071e3] text-white hover:bg-[#0077ed] transition-colors btn-tap whitespace-nowrap"
                >
                  저장
                </button>
                <span className="text-base text-slate-500">다른 기기에서 같은 번호로 들어오면 이 이름이 적용됩니다.</span>
              </div>
              {loginMessage && (
                <p className="text-base text-slate-600 mt-1 px-1">{loginMessage}</p>
              )}
            </div>
          </div>
        </div>
            )}
          </div>
        )}
      </main>

      {/* 하단 네비 - 흰 카드, 선택 칸은 아이콘·글만 파랑 */}
      <nav className="fixed bottom-0 left-0 right-0 max-w-md mx-auto bg-white border-t border-[#e8eef6] flex justify-start gap-0 px-2 py-2">
        <button
          type="button"
          onClick={() => {
            if (!isProfileComplete) {
              setNavView("myinfo");
              setShareToast("이름과 생년월일을 저장하면 이용할 수 있습니다.");
              setTimeout(() => setShareToast(null), 3000);
              return;
            }
            setNavView("record");
            setSelectedGameId(null);
          }}
          className={`flex flex-col items-center gap-0.5 py-2 px-4 min-w-0 nav-tab btn-tap ${!isProfileComplete ? "opacity-60 text-[#9ca3af]" : ""} ${navView === "record" ? "text-[#0071e3] font-semibold" : "text-[#6e6e73]"}`}
        >
          <NavIconGameList className="w-10 h-10 shrink-0" />
          <span className="text-base font-medium leading-tight">오늘</span>
        </button>
        <button
          type="button"
          onClick={() => {
            if (!isProfileComplete) {
              setNavView("myinfo");
              setShareToast("이름과 생년월일을 저장하면 이용할 수 있습니다.");
              setTimeout(() => setShareToast(null), 3000);
              return;
            }
            setNavView("setting");
          }}
          className={`flex flex-col items-center gap-0.5 py-2 px-4 min-w-0 nav-tab btn-tap ${!isProfileComplete ? "opacity-60 text-[#9ca3af]" : ""} ${navView === "setting" ? "text-[#0071e3] font-semibold" : "text-[#6e6e73]"}`}
        >
          <NavIconGameMode className="w-10 h-10 shrink-0" />
          <span className="text-base font-medium leading-tight">새 경기</span>
        </button>
        <button
          type="button"
          onClick={() => setNavView("myinfo")}
          className={`relative flex flex-col items-center gap-0.5 py-2 px-4 min-w-0 nav-tab btn-tap ${navView === "myinfo" ? "text-[#0071e3] font-semibold" : "text-[#6e6e73]"}`}
        >
          <NavIconMyInfo className="w-10 h-10 shrink-0" filled={isProfileComplete} />
          <span className="text-base font-medium leading-tight">내 정보</span>
        </button>
      </nav>

      {/* 경기 생성 전 확인 모달 */}
      {shareToast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40 px-4 py-3 rounded-full bg-slate-800 text-white text-base shadow-lg animate-scale-in" role="status">
          {shareToast}
        </div>
      )}
      {showRegenerateConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 animate-fade-in" aria-modal="true" role="alertdialog" aria-labelledby="regenerate-confirm-title">
          <div
            className="bg-white rounded-3xl shadow-[0_12px_32px_rgba(47,91,160,0.16)] border border-[#e8eef6] max-w-sm w-full p-4 space-y-3 animate-scale-in"
            onTouchStart={(e) => { overlayTouchStartRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY }; }}
            onTouchEnd={(e) => {
              const dy = e.changedTouches[0].clientY - overlayTouchStartRef.current.y;
              const dx = e.changedTouches[0].clientX - overlayTouchStartRef.current.x;
              if (dy > 50 && Math.abs(dy) > Math.abs(dx)) setShowRegenerateConfirm(false);
            }}
          >
            <p id="regenerate-confirm-title" className="text-base text-slate-700 leading-relaxed">
              대진을 다시 만들면 지금 대진이 바뀝니다. 계속할까요?
            </p>
            <div className="flex gap-2 justify-end">
              <button
                type="button"
                onClick={() => setShowRegenerateConfirm(false)}
                className="px-4 py-3 rounded-full text-base font-medium text-slate-700 bg-slate-100 hover:bg-slate-200"
              >
                취소
              </button>
              <button
                type="button"
                onClick={() => {
                  doMatch();
                  setShowRegenerateConfirm(false);
                }}
                className="px-4 py-3 rounded-full text-base font-semibold text-white bg-[#0071e3] hover:bg-[#0077ed]"
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
    <Suspense fallback={<div className="min-h-screen flex items-center justify-center text-slate-500 text-base">로딩 중...</div>}>
      <GameView gameId={null} />
    </Suspense>
  );
}
