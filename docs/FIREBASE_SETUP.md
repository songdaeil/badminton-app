# Firebase 설정 방법 (경기 공유 + 전화번호 로그인)

이 앱에서는 **Firestore**(경기 공유 실시간 동기화)와 **Authentication**(전화번호 로그인)을 사용합니다.

---

## ✅ 내가 할 일 체크리스트

| 순서 | 할 일 | 위치 |
|------|--------|------|
| 1 | Firebase 프로젝트 생성 | 콘솔 홈 |
| 2 | Firestore 데이터베이스 생성 | 빌드 → Firestore Database |
| 3 | Firestore 규칙에 `sharedGames` 읽기/쓰기 허용 | Firestore → 규칙 탭 |
| 4 | 웹 앱 등록 후 설정 6개 값 복사 | 프로젝트 설정 → 일반 → 내 앱 |
| 5 | **전화번호 로그인** 사용 설정 | Authentication → Sign-in method → 전화 |
| 6 | **승인된 도메인**에 사이트 주소 추가 | Authentication → 설정 → 승인된 도메인 |
| 7 | **Blaze 요금제**로 업그레이드 (전화 인증용) | 프로젝트 설정 → 사용량 및 결제 |
| 8 | `.env.local`에 6개 값 넣고 서버 재시작 | 로컬 / 배포 시 환경 변수 동일 적용 |

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

## 5. 로그인 방법 설정 (Authentication)

1. 왼쪽 메뉴 **빌드** → **Authentication** 클릭
2. **시작하기** 클릭(처음이면)
3. **Sign-in method** 탭에서 사용할 방법 **사용 설정**:
   - **이메일/비밀번호**: 클릭 → **사용 설정** 켜기 → **저장** (Blaze 요금제 불필요. 가입 시 인증 메일 발송, 인증 완료 후만 활동 가능해 유령 회원 방지)
   - **전화번호**: 클릭 → **사용 설정** 켜기 → **저장** (Blaze 요금제 필요)

### 5-1. 승인된 도메인 추가 (auth/configuration-not-found 방지)

1. **Authentication** → **설정** 탭 → **승인된 도메인**
2. **도메인 추가**로 아래를 추가:
   - 로컬 개발: `localhost`
   - 배포 주소: 예) `your-app.vercel.app` (실제 배포 URL 입력)

### 5-2. Blaze 요금제 (auth/billing-not-enabled 방지)

전화번호(SMS) 인증은 **Blaze(종량제)** 프로젝트에서만 사용할 수 있습니다.

1. 왼쪽 **⚙ 프로젝트 설정** → **사용량 및 결제**
2. **Blaze 플랜으로 업그레이드** 클릭
3. 결제 수단 등록(무료 할당량 내 사용 시 과금 없음, 소규모 사용 시 비용 거의 없음)

---

## 6. .env.local에 넣기

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

## 7. 개발 서버 재시작

환경 변수는 빌드/실행 시점에 읽히므로, 수정 후 반드시 **개발 서버를 다시 실행**합니다.

```bash
# 서버 중지 후
npm run dev
```

---

## 8. 배포 시 (Vercel 등)

1. Vercel 대시보드 → 해당 프로젝트 → **Settings** → **Environment Variables**
2. 위 6개 Firebase 변수를 **똑같이** 추가
3. **Redeploy**로 다시 배포

---

## 확인

- **경기 공유**: 공유 버튼으로 링크 복사 후 다른 기기에서 열어보기 → 한쪽 수정 시 다른 쪽 갱신 확인
- **전화번호 로그인**: 로그인 화면에서 전화번호 입력 → 인증문자 보내기 → 인증번호 입력 후 로그인 확인

문제가 있으면:
- Firestore → **데이터** 탭에서 `sharedGames` 컬렉션에 문서가 생기는지 확인
- Authentication → **사용자** 탭에서 전화번호 로그인 사용자가 생기는지 확인
