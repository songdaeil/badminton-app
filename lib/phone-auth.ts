"use client";

/**
 * Firebase 전화번호 로그인
 * - Firebase 콘솔에서 Authentication → Sign-in method → 전화번호 사용 설정 필요
 * - 로컬 개발: localhost는 전화 인증 허용 도메인이 아니므로, 콘솔에서 테스트 전화번호 추가 후 사용 권장
 */

import {
  ConfirmationResult,
  RecaptchaVerifier,
  signInWithPhoneNumber,
  signOut as firebaseSignOut,
} from "firebase/auth";
import { getAuthInstance } from "@/lib/firebase";

/** 한국 번호 010-1234-5678 형태를 E.164 (+821012345678)로 변환 */
export function normalizePhoneNumber(input: string): string {
  const digits = input.replace(/\D/g, "");
  if (digits.length >= 9 && digits.startsWith("010")) {
    return "+82" + digits.slice(1);
  }
  if (digits.length >= 10 && digits.startsWith("82")) {
    return "+" + digits;
  }
  if (digits.length >= 9) {
    return "+82" + digits;
  }
  return "+82" + digits;
}

/** reCAPTCHA용 컨테이너 id (페이지에 숨김 div가 있으면 사용, 없으면 동적 생성) */
export const PHONE_RECAPTCHA_CONTAINER_ID = "phone-recaptcha-container";

let recaptchaVerifier: RecaptchaVerifier | null = null;
let lastContainerElement: HTMLElement | null = null;

/**
 * 매번 새 컨테이너에 reCAPTCHA를 그려 "already been rendered in this element" 방지.
 * 이전 컨테이너는 지연 제거해 reCAPTCHA 내부가 element.style 접근하는 동안 제거되지 않도록 함.
 */
function createFreshRecaptchaVerifier(): RecaptchaVerifier {
  const auth = getAuthInstance();
  if (!auth) throw new Error("Firebase Auth가 초기화되지 않았습니다.");
  const previousContainer = lastContainerElement;
  if (recaptchaVerifier) {
    try {
      recaptchaVerifier.clear();
    } catch {
      // ignore
    }
    recaptchaVerifier = null;
  }
  if (typeof document === "undefined" || !document.body) {
    throw new Error("전화 인증은 브라우저 환경에서만 사용할 수 있습니다.");
  }
  const containerId = `phone-recaptcha-${Date.now()}`;
  const el = document.createElement("div");
  el.id = containerId;
  el.setAttribute("aria-hidden", "true");
  el.style.cssText = "position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden;";
  document.body.appendChild(el);
  lastContainerElement = el;
  recaptchaVerifier = new RecaptchaVerifier(auth, containerId, {
    size: "invisible",
    callback: () => {},
    "expired-callback": () => {},
  });
  if (previousContainer?.parentNode) {
    setTimeout(() => previousContainer.remove(), 1000);
  }
  return recaptchaVerifier;
}

/**
 * 전화번호로 인증문자 요청. 성공 시 인증번호 입력 후 confirmPhoneCode 호출.
 */
export async function startPhoneAuth(phoneNumber: string): Promise<ConfirmationResult> {
  const auth = getAuthInstance();
  if (!auth) throw new Error("Firebase Auth가 초기화되지 않았습니다.");
  const normalized = normalizePhoneNumber(phoneNumber);
  const verifier = createFreshRecaptchaVerifier();
  const confirmationResult = await signInWithPhoneNumber(auth, normalized, verifier);
  return confirmationResult;
}

/**
 * 수신한 인증번호로 로그인 완료.
 */
export async function confirmPhoneCode(confirmationResult: ConfirmationResult, code: string): Promise<{ phoneNumber: string }> {
  const result = await confirmationResult.confirm(code);
  const phoneNumber = result.user.phoneNumber ?? "";
  return { phoneNumber };
}

/**
 * 현재 로그인된 Firebase Auth 사용자(전화번호) 반환. 없으면 null.
 */
export function getCurrentPhoneUser(): { phoneNumber: string } | null {
  const auth = getAuthInstance();
  if (!auth?.currentUser?.phoneNumber) return null;
  return { phoneNumber: auth.currentUser.phoneNumber };
}

/**
 * 전화번호 로그아웃
 */
export async function signOutPhone(): Promise<void> {
  const auth = getAuthInstance();
  if (auth) await firebaseSignOut(auth);
  recaptchaVerifier = null;
  if (lastContainerElement?.parentNode) {
    lastContainerElement.remove();
    lastContainerElement = null;
  }
}

export function isPhoneAuthAvailable(): boolean {
  return getAuthInstance() != null;
}
