# 프로젝트 구조 요약

배드민턴 경기 관리 앱의 디렉터리·역할 정리.

## 앱 진입점

- **app/page.tsx** – 메인 페이지. `Home` → `GameView` 한 컴포넌트에 경기 세팅·목록·나의 정보 탭과 상세 UI가 모두 포함됨. (파일이 크므로 수정 시 부담을 줄이려면 이후 컴포넌트/훅 분리 권장)
- **app/game/[id]/page.tsx** – 경기 상세 라우트 (동일 GameView 사용)
- **app/login/page.tsx** – 로그인 전용 페이지
- **app/layout.tsx** – 공통 레이아웃

## 라이브러리 (lib/)

| 파일 | 역할 |
|------|------|
| **game-logic.ts** | 경기 방식 설정(GAME_MODES, TARGET_TOTAL_GAMES_TABLE, GRADE_ORDER), 대진표 생성(buildRoundRobinMatches, generateMatchesByGameMode, getTargetTotalGames) |
| **game-mode-utils.ts** | 시간/코트/포맷 유틸(TIME_OPTIONS_30MIN, createId, formatSavedAt, formatEstimatedDuration, canUseParallelCourts 등). game-logic 일부 re-export |
| **game-share.ts** | 공유 링크용 직렬화/복원(encodeGameForShare, decodeGameFromShare) |
| **match-stats.ts** | 승패·득실차 계산(recomputeMemberStatsFromMatches, buildRankingFromMatchesOnly) |
| **game-storage.ts** | 로컬 저장(loadGame, saveGame, loadGameList, saveGameList, addGameToList, removeGameFromList, loadMyInfo, saveMyInfo) |
| **sync.ts** | Firestore 공유(sharedGames, userGameLists): getSharedGame, setSharedGame, subscribeSharedGame, getUserGameList, setUserGameList, subscribeUserGameList |
| **firebase.ts** | Firebase 앱·Auth·Firestore 초기화 |
| **profile-sync.ts** | 프로필 원격 조회/저장(getRemoteProfile, setRemoteProfile) |
| **email-auth.ts** | 이메일 로그인/회원가입/인증 |
| **phone-auth.ts** | 전화번호 로그인 |

## 앱 전용 (app/)

- **constants.ts** – PRIMARY, PRIMARY_LIGHT, LOGIN_GATE_KEY, NAV_ORDER, NavView 타입
- **types.ts** – Member, Match, Team, GameMode, Grade 등 공통 타입
- **hooks/useGameListSync.ts** – 로그인 UID 기준 경기 목록 Firestore 동기화(구독 + 병합 업로드)
- **components/AddMemberForm.tsx** – 명단 추가 폼
- **components/AppNav.tsx** – 하단 네비(경기 방식 / 경기 목록 / 경기 이사)
- **components/GameViewHeader.tsx** – 상단 헤더(제목 + 도움말 버튼)
- **components/HelpModals.tsx** – 경기 방식·경기 목록 도움말 팝업
- **components/RegenerateConfirmModal.tsx** – 경기 생성 전 확인 모달
- **components/ShareToast.tsx** – 공유/안내 토스트
- **components/panels/SettingPanel.tsx** – 경기 세팅 패널(경기 방식 카테고리·목록·상세·목록에 추가)
- **components/panels/RecordPanel.tsx** – 경기 목록 패널(목록 카드·메뉴·상세: 요약·명단·대진·경기 현황·랭킹)
- **components/panels/MyInfoPanel.tsx** – 나의 정보 패널(로그인 상태·프로필·프로필 수정 오버레이)
- **contexts/GameViewContext.tsx** – GameView 공통 state/핸들러(useGameView, GameViewProvider)
- **components/nav-icons.tsx** – 하단 탭 아이콘
- **components/category-icons.tsx** – 경기 방식 카테고리 아이콘
- **components/profile-badge.tsx** – 프로필 뱃지 UI

## 데이터 흐름 요약

- **경기 데이터**: 로컬(game-storage) + 공유 시 Firestore(sync). 경기 상세는 subscribeSharedGame으로 실시간 반영.
- **경기 목록**: 로컬 목록 + 로그인 시 userGameLists와 동기화(useGameListSync). 추가/삭제 시 원격과 병합 후 업로드.
- **프로필**: 로컬(myInfo) + 로그인 UID 기준 Firestore(profile-sync).

## 최적화 시 참고

- **page.tsx** 줄이기: GameView 내부를 “경기 세팅 / 경기 목록 / 나의 정보” 섹션별 컴포넌트로 쪼개거나, 로그인·공유 링크 처리 등을 훅으로 분리하면 편집·빌드 부담이 줄어듦.
- **중복 제거**: 새 로직은 위 lib/ 역할에 맞는 파일에 두고, page.tsx에는 import만 두면 유지보수와 에디터 부하에 유리함.
