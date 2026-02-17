/**
 * 카카오 로그인 (JavaScript SDK 2.x)
 *
 * [처음 설정]
 * 1. developers.kakao.com → 내 애플리케이션 → 앱 추가
 * 2. 앱 설정 → 플랫폼 → Web → 사이트 도메인에 http://localhost:3000 (개발용) 등록
 * 3. 제품 설정 → 카카오 로그인 → Redirect URI에 아래 주소 그대로 등록
 *    → http://localhost:3000/auth/kakao/callback
 * 4. 앱 키에서 JavaScript 키, REST API 키 복사 → .env.local에 설정
 */

export interface KakaoUserProfile {
  nickname: string;
  email: string;
}

declare global {
  interface Window {
    Kakao?: {
      init: (key: string) => void;
      isInitialized: () => boolean;
      Auth: {
        authorize: (options: {
          redirectUri: string;
          scope?: string;
        }) => void;
        logout: (callback?: () => void) => void;
        getAccessToken: () => string | null;
        setAccessToken: (token: string) => void;
      };
      API: {
        request: (options: {
          url: string;
          success?: (res: unknown) => void;
          fail?: (err: unknown) => void;
        }) => void;
      };
    };
  }
}

export function getKakaoJsKey(): string | undefined {
  if (typeof window === "undefined") return undefined;
  return process.env.NEXT_PUBLIC_KAKAO_JAVASCRIPT_KEY;
}

/** 콜백 URL. 카카오 콘솔에 등록한 값과 완전히 동일해야 함. */
export function getKakaoRedirectUri(): string {
  const env = process.env.NEXT_PUBLIC_KAKAO_REDIRECT_URI?.trim();
  if (env) return env;
  if (typeof window !== "undefined") {
    return `${window.location.origin}/auth/kakao/callback`;
  }
  return "";
}

export function initKakao(): boolean {
  if (typeof window === "undefined") return false;
  const key = getKakaoJsKey();
  if (!key || !window.Kakao) return false;
  if (window.Kakao.isInitialized?.()) return true;
  try {
    window.Kakao.init(key);
    return true;
  } catch {
    return false;
  }
}

/** 카카오 동의 화면으로 이동(리다이렉트). 동의 후 /auth/kakao/callback 으로 돌아옴 */
export function loginWithKakao(): void {
  if (typeof window === "undefined") return;
  if (!window.Kakao || !initKakao()) return;
  // 닉네임 + 프로필 사진 요청
  window.Kakao.Auth.authorize({
    redirectUri: getKakaoRedirectUri(),
    scope: "profile_nickname,profile_image",
  });
}

export function logoutKakao(): void {
  if (typeof window === "undefined") return;
  window.Kakao?.isInitialized?.() && window.Kakao.Auth.logout();
}
