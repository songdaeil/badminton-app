# 배드민턴 경기 관리 앱 — 문서

이 문서는 프로젝트 구조, Firebase 설정, 경기 목록 동기화를 한 곳에서 관리합니다.

---

## 목차

1. [프로젝트 소개 및 실행](#1-프로젝트-소개-및-실행)
2. [프로젝트 구조](#2-프로젝트-구조)
3. [Firebase 설정](#3-firebase-설정)
4. [경기 목록 동기화](#4-경기-목록-동기화)
5. [사용자 시나리오·구조 이해 및 개선 제안](#5-사용자-시나리오구조-이해-및-개선-제안)

---

## 1. 프로젝트 소개 및 실행

배드민턴 경기 관리 앱(Next.js)입니다. 경기 방식 선택, 명단·대진 관리, 경기 결과 입력·랭킹, 로컬 저장, 공유 링크(Firestore), 이메일/전화번호 로그인·경기 목록·프로필 동기화를 지원합니다.

**기술 스택**: Next.js, React, TypeScript, Firebase (Auth, Firestore)

### 실행 방법

```bash
npm install
npm run dev
```

브라우저에서 [http://localhost:3000](http://localhost:3000) 접속.

Firebase(경기 공유·로그인·경기 목록 동기화)를 사용하려면 [Firebase 설정](#3-firebase-설정)을 참고해 `.env.local`에 환경 변수를 넣은 뒤 서버를 재시작하세요.

---

## 2. 프로젝트 구조

배드민턴 경기 관리 앱의 디렉터리·역할 정리.

### 앱 진입점

- **app/page.tsx** – 메인 페이지. `Home` → `GameView` 한 컴포넌트에 경기 세팅·목록·나의 정보 탭과 상세 UI가 모두 포함됨. (파일이 크므로 수정 시 부담을 줄이려면 이후 컴포넌트/훅 분리 권장)
- **app/game/[id]/page.tsx** – 경기 상세 라우트 (동일 GameView 사용)
- **app/login/page.tsx** – 로그인 전용 페이지 (현재는 `/`로 리다이렉트, 실제 로그인 UI는 메인의 나의 정보에 있음)
- **app/layout.tsx** – 공통 레이아웃

### 라이브러리 (lib/)

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

### 앱 전용 (app/)

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

### 데이터 흐름 요약

- **경기 데이터**: 로컬(game-storage) + 공유 시 Firestore(sync). 경기 상세는 subscribeSharedGame으로 실시간 반영.
- **경기 목록**: 로컬 목록 + 로그인 시 userGameLists와 동기화(useGameListSync). 추가/삭제 시 원격과 병합 후 업로드.
- **프로필**: 로컬(myInfo) + 로그인 UID 기준 Firestore(profile-sync).

### 최적화 시 참고

- **page.tsx** 줄이기: GameView 내부를 "경기 세팅 / 경기 목록 / 나의 정보" 섹션별 컴포넌트로 쪼개거나, 로그인·공유 링크 처리 등을 훅으로 분리하면 편집·빌드 부담이 줄어듦.
- **중복 제거**: 새 로직은 위 lib/ 역할에 맞는 파일에 두고, page.tsx에는 import만 두면 유지보수와 에디터 부하에 유리함.

---

## 3. Firebase 설정

이 앱에서는 **Firestore**(경기 공유·경기 목록·프로필 동기화)와 **Authentication**(이메일/전화번호 로그인)을 사용합니다.

### 체크리스트

| 순서 | 할 일 | 위치 |
|------|--------|------|
| 1 | Firebase 프로젝트 생성 | 콘솔 홈 |
| 2 | Firestore 데이터베이스 생성 | 빌드 → Firestore Database |
| 3 | Firestore 규칙에 `sharedGames`, `users`, `userGameLists` 설정 | Firestore → 규칙 탭 |
| 4 | 웹 앱 등록 후 설정 6개 값 복사 | 프로젝트 설정 → 일반 → 내 앱 |
| 5 | **전화번호 로그인** 사용 설정 | Authentication → Sign-in method → 전화 |
| 6 | **승인된 도메인**에 사이트 주소 추가 | Authentication → 설정 → 승인된 도메인 |
| 7 | **Blaze 요금제**로 업그레이드 (전화 인증용) | 프로젝트 설정 → 사용량 및 결제 |
| 8 | `.env.local`에 6개 값 넣고 서버 재시작 | 로컬 / 배포 시 환경 변수 동일 적용 |

### 3-1. Firebase 프로젝트 만들기

1. [Firebase 콘솔](https://console.firebase.google.com/) 접속 후 Google 로그인
2. **프로젝트 추가** 클릭
3. 프로젝트 이름 입력(예: `badminton-app`) → **계속**
4. Google Analytics 사용 여부 선택 후 **프로젝트 만들기** → 완료될 때까지 대기

### 3-2. Firestore 데이터베이스 만들기

1. 왼쪽 메뉴에서 **빌드** → **Firestore Database** 클릭
2. **데이터베이스 만들기** 클릭
3. **테스트 모드로 시작** 선택(나중에 규칙 수정 예정) → **다음**
4. 위치 선택(예: `asia-northeast3` 서울) → **사용 설정**

### 3-3. Firestore 보안 규칙 설정

1. Firestore 화면 상단 **규칙** 탭 클릭
2. 아래 규칙으로 **전체 교체** 후 **게시**

```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // 경기 공유: shareId를 아는 사람만 링크로 접근 (공유 링크 = 비밀키)
    match /sharedGames/{shareId} {
      allow read, write: if true;
    }
    // 로그인 사용자 프로필: 본인 UID 문서만 읽기/쓰기 (다른 기기 동기화)
    match /users/{userId} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
    }
    // 로그인 사용자 경기 목록: 본인 UID 문서만 읽기/쓰기 (경기 목록 동기화)
    match /userGameLists/{userId} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
    }
  }
}
```

- **sharedGames**: 링크를 아는 사람만 해당 경기 문서에 접근합니다. shareId는 예측하기 어려운 랜덤 문자열입니다.
- **users**: 로그인한 사용자만 자신의 문서(`/users/{본인 uid}`)를 읽고 쓸 수 있습니다. 같은 이메일/전화번호로 다른 기기에서 로그인하면 동일한 프로필이 표시됩니다.
- **userGameLists**: 로그인한 사용자만 자신의 경기 목록 문서(`/userGameLists/{본인 uid}`)를 읽고 쓸 수 있습니다. 경기 목록 동기화에 필요합니다.

### 3-4. 웹 앱 등록 및 설정값 복사

1. 프로젝트 개요 옆 **휠(설정)** 아이콘 → **프로젝트 설정**
2. **일반** 탭에서 아래로 내려가 **내 앱** 섹션으로 이동
3. **</> 웹** 아이콘 클릭(웹 앱 추가)
4. 앱 닉네임 입력(예: `badminton-web`) → **앱 등록**
5. **Firebase SDK** 구성에서 `firebaseConfig` 객체 확인
6. 아래 6개 값을 복사해 둡니다:

| 환경 변수 이름 | firebaseConfig 필드 |
|----------------|----------------------|
| `NEXT_PUBLIC_FIREBASE_API_KEY` | `apiKey` |
| `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN` | `authDomain` |
| `NEXT_PUBLIC_FIREBASE_PROJECT_ID` | `projectId` |
| `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET` | `storageBucket` |
| `NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID` | `messagingSenderId` |
| `NEXT_PUBLIC_FIREBASE_APP_ID` | `appId` |

### 3-5. 로그인 방법 설정 (Authentication)

1. 왼쪽 메뉴 **빌드** → **Authentication** 클릭
2. **시작하기** 클릭(처음이면)
3. **Sign-in method** 탭에서 사용할 방법 **사용 설정**:
   - **이메일/비밀번호**: 클릭 → **사용 설정** 켜기 → **저장** (Blaze 요금제 불필요. 가입 시 인증 메일 발송, 인증 완료 후만 활동 가능해 유령 회원 방지)
   - **전화번호**: 클릭 → **사용 설정** 켜기 → **저장** (Blaze 요금제 필요)

#### 승인된 도메인 추가 (auth/configuration-not-found 방지)

1. **Authentication** → **설정** 탭 → **승인된 도메인**
2. **도메인 추가**로 아래를 추가:
   - 로컬 개발: `localhost`
   - 배포 주소: 예) `your-app.vercel.app` (실제 배포 URL 입력)

#### Blaze 요금제 (auth/billing-not-enabled 방지)

전화번호(SMS) 인증은 **Blaze(종량제)** 프로젝트에서만 사용할 수 있습니다.

1. 왼쪽 **⚙ 프로젝트 설정** → **사용량 및 결제**
2. **Blaze 플랜으로 업그레이드** 클릭
3. 결제 수단 등록(무료 할당량 내 사용 시 과금 없음, 소규모 사용 시 비용 거의 없음)

### 3-6. .env.local에 넣기

프로젝트 루트의 **`.env.local`** 파일을 열고(없으면 `.env.example`을 복사해 `.env.local`로 저장) 아래 형식으로 추가합니다.

```env
# Firebase (경기 공유·경기 목록·프로필 동기화)
NEXT_PUBLIC_FIREBASE_API_KEY=여기에_apiKey_값
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=여기에_authDomain_값
NEXT_PUBLIC_FIREBASE_PROJECT_ID=여기에_projectId_값
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=여기에_storageBucket_값
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=여기에_messagingSenderId_값
NEXT_PUBLIC_FIREBASE_APP_ID=여기에_appId_값
```

- 값만 넣고, 앞뒤 공백 없이, 따옴표 없이 적습니다.
- `.env.local`은 Git에 올리지 마세요(이미 `.gitignore`에 있을 수 있음).

### 3-7. 개발 서버 재시작

환경 변수는 빌드/실행 시점에 읽히므로, 수정 후 반드시 **개발 서버를 다시 실행**합니다.

```bash
# 서버 중지 후
npm run dev
```

### 3-8. 배포 시 (Vercel 등)

1. Vercel 대시보드 → 해당 프로젝트 → **Settings** → **Environment Variables**
2. 위 6개 Firebase 변수를 **똑같이** 추가
3. **Redeploy**로 다시 배포

### 확인

- **경기 공유**: 공유 버튼으로 링크 복사 후 다른 기기에서 열어보기 → 한쪽 수정 시 다른 쪽 갱신 확인
- **경기 목록 동기화**: 로그인 후 경기 목록에 추가·삭제 후 다른 기기에서 같은 계정으로 로그인해 목록 일치 확인
- **전화번호 로그인**: 로그인 화면에서 전화번호 입력 → 인증문자 보내기 → 인증번호 입력 후 로그인 확인

문제가 있으면:
- Firestore → **데이터** 탭에서 `sharedGames`, `userGameLists`, `users` 컬렉션 문서 확인
- Authentication → **사용자** 탭에서 로그인 사용자 확인

---

## 4. 경기 목록 동기화

새로고침 시 경기 목록이 어디서 오는지 데이터 소스와 흐름을 정리한 설명입니다.

### 결론: 최종 소스는 Firebase, 화면은 localStorage를 읽음

- **진짜 데이터 원천**: Firebase Firestore `userGameLists/{uid}` 문서 (해당 UID의 경기 목록).
- **화면이 읽는 곳**: **localStorage** 키 `badminton-game-list`. 이 값은 동기화 훅이 Firebase에서 가져와 덮어쓴 결과입니다.

즉, "올라오는 내용"은 **Firebase가 원본**이고, 앱은 그걸 로컬에 저장한 뒤 그 로컬을 UI 소스로 씁니다.

### 데이터 흐름 (새로고침 시)

```mermaid
sequenceDiagram
  participant UI
  participant useGameListSync
  participant localStorage
  participant Firebase

  Note over UI,Firebase: 새로고침 직후
  UI->>localStorage: loadGameList() (badminton-game-list)
  localStorage-->>UI: 이전 세션 캐시 (같은 UID면 그대로 표시)
  useGameListSync->>Firebase: getUserGameList(authUid)
  Firebase-->>useGameListSync: userGameLists/{uid} 문서의 list
  useGameListSync->>useGameListSync: resolveToLocalEntries (shareId→로컬 id 해석)
  useGameListSync->>localStorage: saveGameList(resolved ids)
  useGameListSync->>UI: onListChange() → 리렌더
  UI->>localStorage: loadGameList()
  localStorage-->>UI: Firebase 기준으로 갱신된 목록
```

- **1단계**: 첫 렌더에서 UI는 `loadGameList()`로 **localStorage**만 읽습니다. (계정 전환 시에만 비우도록 되어 있어, 새로고침 시에는 비우지 않아 같은 기기·같은 UID면 이전 목록이 잠깐 보일 수 있음.)
- **2단계**: app/hooks/useGameListSync.ts의 `useEffect`에서 `getUserGameList(authUid)`로 **Firebase `userGameLists/{uid}`**를 조회합니다.
- **3단계**: `applyServerList` → `resolveToLocalEntries`로 서버 항목을 로컬 id로 바꾼 뒤, `saveGameList(resolved)`로 **localStorage를 Firebase 기준으로 덮어씁니다.**
- **4단계**: `onListChange()`로 리렌더가 일어나고, UI는 다시 `loadGameList()`를 호출해 **이미 Firebase 기준으로 갱신된 localStorage**를 읽어서 화면에 냅니다.

**알려진 동작**: 새로고침 직후 같은 UID·같은 기기에서는 짧은 시간 **이전 세션 목록이 보였다가** Firebase 기준으로 바뀔 수 있습니다. Firebase 응답 전까지 로딩만 보이게 하려면 별도 수정이 필요합니다.

### 관련 코드 위치

| 역할 | 파일 | 설명 |
|------|------|------|
| 경기 목록 ID 배열 저장/로드 | lib/game-storage.ts | `loadGameList()` / `saveGameList()` — localStorage `badminton-game-list` |
| Firestore 경기 목록 조회/구독 | lib/sync.ts | `getUserGameList(uid)`, `subscribeUserGameList(uid)` — 컬렉션 `userGameLists`, 문서 id = uid |
| 동기화 훅 (소스 적용) | app/hooks/useGameListSync.ts | `getUserGameList(authUid).then(applyServerList)` → `saveGameList` + `onListChange` |
| 화면 표시 | app/page.tsx | `loadGameList()`로 id 배열 읽고, 각 id로 `loadGame(id)` 해서 카드 렌더 |

이 동작을 바꾸고 싶다면 (예: "Firebase 응답 올 때까지 로딩만 보이게" 등) 별도 요구사항에 맞춰 수정할 수 있습니다.

---

## 5. 사용자 시나리오·구조 이해 및 개선 제안

사용자 운영 시나리오에 맞춰 전체 구조를 정리하고, 성능·유지보수 관점의 문제점과 개선안을 제안합니다.

### 5.1 사용자 운영 시나리오 요약

| 시나리오 | 흐름 | 관련 코드 |
|----------|------|-----------|
| 앱 진입·로그인 | 로그인 게이트(건너뛰기/이메일/전화) → 메인(경기 방식·경기 목록·나의 정보 탭) | page.tsx 로그인 게이트, onAuthStateChanged, 나의 정보 탭 |
| 경기 세팅 | 경기 방식 선택 → 명단 추가 → 경기 생성 → 목록에 추가 | page.tsx 경기 방식 섹션, AddMemberForm, doMatch, addGameToRecord |
| 경기 목록·상세 | 목록에서 경기 선택 → 상세(요약·명단·대진·경기 현황·랭킹) → 점수 입력·저장 | page.tsx record 섹션, loadGameList/loadGame, saveResult |
| 공유 | 공유 버튼 → Firestore 업로드/기존 shareId 사용 → 링크 복사 → 다른 기기에서 링크로 진입 | handleShareCard, processShareAndOpenDetail, subscribeSharedGame |
| 경기 목록 동기화 | 로그인 후 목록을 Firebase에서 로드·구독 → 추가/삭제 시 원격 반영 | useGameListSync, getUserGameList, subscribeUserGameList |
| 프로필 동기화 | 로그인 시 Firestore에서 프로필 로드 → 수정 후 업로드 | getRemoteProfile, setRemoteProfile, uploadProfileToFirestore |

### 5.2 현재 구조상 문제점

#### 유지보수 관점

- **app/page.tsx 단일 대형 컴포넌트**: 약 3,500줄으로, 경기 세팅·목록·나의 정보·로그인·공유·모달 등 모든 UI와 상태·핸들러가 한 파일에 있음. 수정·추가 시 충돌과 부담이 크고, 테스트·리뷰가 어렵습니다.
- **lib와의 중복**: `encodeGameForShare`, `decodeGameFromShare`(lib/game-share.ts), `recomputeMemberStatsFromMatches`, `buildRankingFromMatchesOnly`(lib/match-stats.ts), `buildRoundRobinMatches`, `generateMatchesByGameMode`, `getTargetTotalGames`, `GAME_MODES`, `TARGET_TOTAL_GAMES_TABLE`, `GRADE_ORDER`, `formatSavedAt`, `formatEstimatedDuration`, `createId`, `pairKey` 등이 page.tsx 내부에 다시 정의되어 있습니다. lib 수정 시 page와 불일치할 위험이 있습니다.
- **컴포넌트 미사용**: `SettingPanel`, `RecordPanel`, `MyInfoPanel`은 `useGameView()`를 쓰지만, `GameViewProvider`가 page.tsx에서 사용되지 않아 해당 패널은 현재 렌더되지 않습니다. 동일한 역할의 UI가 page.tsx에 인라인으로만 존재합니다.
- **ID 생성 불일치**: `lib/game-storage.ts`의 `createGameId`는 8자(`slice(2,10)`), `lib/game-logic.ts`·page 내부 `createId`는 9자(`slice(2,11)`). 경기 ID와 매치/팀 ID 출처가 혼재됩니다.

#### 성능 관점

- **단일 컴포넌트 재렌더**: GameView 한 컴포넌트에 수십 개의 useState가 있어, 점수 입력·명단 변경·탭 전환 등 어떤 상태 변경이든 전체가 재렌더됩니다. 점수 입력 시 매 키 입력마다 전체 트리가 리렌더될 수 있습니다.
- **파생 값의 매 렌더 계산**: `playingMatchIdsSet`, `playingMatches`, `playableMatches`, `playableMatchIdsSet`, `restingIds`, `waitingMembers` 등이 useMemo 없이 매 렌더마다 새로 계산됩니다. 경기 수가 많을수록 불필요한 연산이 반복됩니다.
- **Firebase 구독 시점**: `subscribeUserGameList`는 `getDb()`만 호출합니다. `getDb()`는 `initFirebase()`를 호출하지 않으므로, auth effect보다 먼저 useGameListSync effect가 실행되면 db가 null인 상태에서 구독이 걸리지 않아, 경기 목록 실시간 반영이 동작하지 않을 수 있습니다.
- **대진 생성 알고리즘**: `buildRoundRobinMatches`는 인원·경기 수에 따라 O(n^4)에 가까운 루프를 매 스텝 돌립니다. 인원이 많을 때 경기 생성 버튼 클릭 시 체감 지연이 생길 수 있습니다.

### 5.3 개선 제안

#### 유지보수

1. **page.tsx 분리**:  
   - 경기 세팅 / 경기 목록 / 나의 정보를 **섹션별 컴포넌트**로 분리하고, 상태·핸들러는 훅(예: useGameState, useAuth, useShare)으로 묶어서 전달하거나, Context를 제대로 도입해 Provider를 한 곳에서만 주입합니다.  
   - 공유 링크 처리(?share=), 로그인 게이트, 모달(경기 생성 확인·도움말) 등은 각각 훅 또는 작은 컴포넌트로 분리합니다.

2. **lib 일원화**:  
   - page.tsx 내부의 `encodeGameForShare`, `decodeGameFromShare`, `recomputeMemberStatsFromMatches`, `buildRankingFromMatchesOnly`, `buildRoundRobinMatches`, `generateMatchesByGameMode`, `getTargetTotalGames`, `GAME_MODES`, `GRADE_ORDER`, `formatSavedAt`, `formatEstimatedDuration`, `createId` 등은 **삭제하고 lib/game-share, lib/match-stats, lib/game-logic, lib/game-mode-utils에서만 import**하도록 합니다.  
   - `AddMemberForm`은 app/components/AddMemberForm.tsx를 사용하고, page 내부 중복 정의를 제거합니다.

3. **Context·패널 정리**:  
   - GameViewProvider를 page.tsx(또는 상위 레이아웃)에서 한 번만 사용하고, value를 useMemo로 스플리트(예: 설정용·목록용·나의 정보용 객체를 나누거나, dispatch만 내려주기)해 불필요한 리렌더를 줄입니다.  
   - 현재 인라인된 “경기 방식 / 경기 목록 / 나의 정보” UI를 SettingPanel, RecordPanel, MyInfoPanel로 점진적으로 교체하면, 역할별로 파일이 나뉘어 유지보수가 쉬워집니다.

4. **ID 생성 통일**:  
   - 경기·매치·팀 ID 생성은 **한 곳**(예: lib/game-storage의 createGameId 또는 lib/game-mode-utils의 createId)만 사용하고, 길이·형식을 동일하게 맞춥니다.

#### 성능

1. **Firebase 구독 전 초기화 보장**:  
   - `lib/sync.ts`의 `subscribeUserGameList`, `subscribeSharedGame`에서 구독을 걸기 전에 `await ensureFirebase()`를 한 번 호출하도록 하거나, 앱 마운트 시(예: layout 또는 최상위 Provider)에서 `ensureFirebase()`를 호출해, useGameListSync 실행 시점에 db가 이미 설정되도록 합니다.

2. **파생 값 메모이제이션**:  
   - `playingMatchIdsSet`, `playingMatches`, `playableMatches`, `playableMatchIdsSet`, `restingIds`, `waitingMembers` 등은 **useMemo**로 감싸고, 의존 배열은 `matches`, `members`, `selectedPlayingMatchIds` 등 최소한으로 둡니다.  
   - `ranking`은 이미 useMemo로 되어 있으므로 유지합니다.

3. **점수 입력·요약 입력 디바운스 유지**:  
   - 저장·Firestore 업로드는 이미 디바운스되어 있으므로 유지하고, 필요 시 로컬 state(scoreInputs, gameName, gameSettings)만 제어하는 하위 컴포넌트로 분리해, 해당 구역만 리렌더되게 할 수 있습니다.

4. **대진 생성**:  
   - 인원이 많은 경우(예: 10명 이상)에는 `buildRoundRobinMatches`를 Web Worker로 옮기거나, 단계 수를 줄이는 휴리스틱을 검토해 메인 스레드 블로킹을 줄입니다.

### 5.4 적용 우선순위 제안

| 우선순위 | 항목 | 기대 효과 |
|----------|------|-----------|
| 1 | Firebase 구독 전 ensureFirebase 호출 | 경기 목록·공유 경기 실시간 동기화 안정화 |
| 2 | page.tsx 내 lib 중복 제거(import로 통일) | 단일 소스 유지, 버그 감소 |
| 3 | 파생 값 useMemo 적용 | 불필요한 재계산·리렌더 감소 |
| 4 | GameViewProvider 도입 + 패널 컴포넌트 사용 | 파일 분리, 역할 명확화 |
| 5 | 경기 세팅/목록/나의 정보를 훅·하위 컴포넌트로 분리 | page.tsx 축소, 유지보수·테스트 용이 |
| 6 | createGameId/createId 통일 | ID 정책 일관성 |
| 7 | (선택) 대진 생성 Worker/휴리스틱 | 대규모 인원 시 반응성 개선 |
