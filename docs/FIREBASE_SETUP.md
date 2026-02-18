# Firebase 설정 방법 (경기 공유 실시간 동기화)

이 앱에서는 **Firestore**를 사용해 공유된 경기 데이터를 실시간으로 동기화합니다.

---

## 1. Firebase 프로젝트 만들기

1. [Firebase 콘솔](https://console.firebase.google.com/) 접속 후 Google 로그인
2. **프로젝트 추가** 클릭
3. 프로젝트 이름 입력(예: `badminton-app`) → **계속**
4. Google Analytics 사용 여부 선택 후 **프로젝트 만들기** → 완료될 때까지 대기

---

## 2. Firestore 데이터베이스 만들기

1. 왼쪽 메뉴에서 **빌드** → **Firestore Database** 클릭
2. **데이터베이스 만들기** 클릭
3. **테스트 모드로 시작** 선택(나중에 규칙 수정 예정) → **다음**
4. 위치 선택(예: `asia-northeast3` 서울) → **사용 설정**

---

## 3. Firestore 보안 규칙 설정

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
  }
}
```

> 링크를 아는 사람만 해당 경기 문서에 접근할 수 있습니다. shareId는 예측하기 어려운 랜덤 문자열입니다.

---

## 4. 웹 앱 등록 및 설정값 복사

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

---

## 5. .env.local에 넣기

프로젝트 루트의 **`.env.local`** 파일을 열고(없으면 `.env.example`을 복사해 `.env.local`로 저장) 아래 형식으로 추가합니다.

```env
# Firebase (경기 공유 실시간 동기화)
NEXT_PUBLIC_FIREBASE_API_KEY=여기에_apiKey_값
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=여기에_authDomain_값
NEXT_PUBLIC_FIREBASE_PROJECT_ID=여기에_projectId_값
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=여기에_storageBucket_값
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=여기에_messagingSenderId_값
NEXT_PUBLIC_FIREBASE_APP_ID=여기에_appId_값
```

- 값만 넣고, 앞뒤 공백 없이, 따옴표 없이 적습니다.
- `.env.local`은 Git에 올리지 마세요(이미 `.gitignore`에 있을 수 있음).

---

## 6. 개발 서버 재시작

환경 변수는 빌드/실행 시점에 읽히므로, 수정 후 반드시 **개발 서버를 다시 실행**합니다.

```bash
# 서버 중지 후
npm run dev
```

---

## 7. 배포 시 (Vercel 등)

1. Vercel 대시보드 → 해당 프로젝트 → **Settings** → **Environment Variables**
2. 위 6개 Firebase 변수를 **똑같이** 추가
3. **Redeploy**로 다시 배포

---

## 확인

- **공유** 버튼으로 링크 복사 후 다른 기기/브라우저에서 열어보기
- 한쪽에서 명단·경기 결과를 수정하면 다른 쪽에서 **목록/상세**가 최신으로 갱신되는지 확인

문제가 있으면 Firebase 콘솔 → Firestore → **데이터** 탭에서 `sharedGames` 컬렉션에 문서가 생기는지 확인해 보세요.
