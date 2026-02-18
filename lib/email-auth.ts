"use client";

/**
 * Firebase 이메일/비밀번호 로그인 + 이메일 인증(sendEmailVerification)
 * - Firebase 콘솔: Authentication → Sign-in method → 이메일/비밀번호 사용 설정
 * - Blaze 요금제 불필요 (전화 인증과 달리)
 * - 가입 후 인증 메일 발송; 인증 완료 전까지 활동 제한으로 유령 회원 방지
 */

import {
  createUserWithEmailAndPassword,
  sendEmailVerification,
  signInWithEmailAndPassword,
  signOut as firebaseSignOut,
} from "firebase/auth";
import { getAuthInstance } from "@/lib/firebase";

export async function signUpWithEmail(email: string, password: string): Promise<{ email: string; needsVerification: boolean }> {
  const auth = getAuthInstance();
  if (!auth) throw new Error("Firebase Auth가 초기화되지 않았습니다.");
  const result = await createUserWithEmailAndPassword(auth, email.trim(), password);
  await sendEmailVerification(result.user);
  return {
    email: result.user.email ?? email.trim(),
    needsVerification: !result.user.emailVerified,
  };
}

export async function signInWithEmail(email: string, password: string): Promise<{ email: string; emailVerified: boolean }> {
  const auth = getAuthInstance();
  if (!auth) throw new Error("Firebase Auth가 초기화되지 않았습니다.");
  const result = await signInWithEmailAndPassword(auth, email.trim(), password);
  return {
    email: result.user.email ?? email.trim(),
    emailVerified: result.user.emailVerified,
  };
}

/** 인증 메일 다시 보내기 (이메일 미인증 시) */
export async function sendVerificationEmailAgain(): Promise<void> {
  const auth = getAuthInstance();
  if (!auth?.currentUser) throw new Error("로그인된 사용자가 없습니다.");
  await sendEmailVerification(auth.currentUser);
}

export async function signOutEmail(): Promise<void> {
  const auth = getAuthInstance();
  if (auth) await firebaseSignOut(auth);
}

export function getCurrentEmailUser(): { email: string; emailVerified: boolean } | null {
  const auth = getAuthInstance();
  const user = auth?.currentUser;
  if (!user?.email) return null;
  return { email: user.email, emailVerified: user.emailVerified };
}

export type AuthUserSnapshot = { email: string; emailVerified: boolean } | null;

/** 인증 상태 변경 구독. emailVerified 갱신을 위해 user.reload() 후 콜백 호출 */
export function subscribeEmailAuthState(
  onUser: (user: AuthUserSnapshot) => void
): () => void {
  const auth = getAuthInstance();
  if (!auth) return () => {};
  const unsubscribe = auth.onAuthStateChanged(async (user) => {
    if (!user) {
      onUser(null);
      return;
    }
    try {
      await user.reload();
      const current = auth.currentUser;
      if (current?.email) {
        onUser({ email: current.email, emailVerified: current.emailVerified });
      } else {
        onUser(null);
      }
    } catch {
      onUser(user.email ? { email: user.email, emailVerified: user.emailVerified } : null);
    }
  });
  return unsubscribe;
}

export function isEmailAuthAvailable(): boolean {
  return getAuthInstance() != null;
}
