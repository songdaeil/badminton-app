"use client";

/**
 * 로그인 사용자 프로필을 Firestore users/{uid}에 저장·불러와
 * 같은 계정으로 다른 기기에서도 동일한 프로필을 쓰도록 합니다.
 */

import { doc, getDoc, setDoc, serverTimestamp } from "firebase/firestore";
import type { MyInfo } from "@/lib/game-storage";
import { ensureFirebase, getDb } from "@/lib/firebase";
import { getAuthInstance } from "@/lib/firebase";

const USERS_COLLECTION = "users";

/** Firestore에는 undefined 불가. 저장 시 null로 치환 */
function toStoredProfile(info: MyInfo): Record<string, string | null> {
  return {
    name: info.name ?? "",
    gender: info.gender ?? "M",
    grade: info.grade ?? null,
    profileImageUrl: info.profileImageUrl ?? null,
    phoneNumber: info.phoneNumber ?? null,
    birthDate: info.birthDate ?? null,
  };
}

function fromStoredProfile(raw: unknown): MyInfo | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const name = typeof o.name === "string" ? o.name : "";
  const gender = o.gender === "F" ? "F" : "M";
  const grade = o.grade === "A" || o.grade === "B" || o.grade === "C" || o.grade === "D" ? o.grade : "D";
  return {
    name,
    gender,
    grade,
    profileImageUrl: typeof o.profileImageUrl === "string" && o.profileImageUrl ? o.profileImageUrl : undefined,
    phoneNumber: typeof o.phoneNumber === "string" && o.phoneNumber ? o.phoneNumber : undefined,
    birthDate: typeof o.birthDate === "string" && o.birthDate ? o.birthDate : undefined,
  };
}

/** 현재 로그인한 사용자 UID (이메일/전화번호 로그인 공통) */
export function getCurrentUserUid(): string | null {
  return getAuthInstance()?.currentUser?.uid ?? null;
}

/** Firestore에서 프로필 불러오기. 없으면 null */
export async function getRemoteProfile(uid: string): Promise<MyInfo | null> {
  const ok = await ensureFirebase();
  const db = getDb();
  if (!ok || !db) return null;
  try {
    const ref = doc(db, USERS_COLLECTION, uid);
    const snap = await getDoc(ref);
    if (!snap.exists()) return null;
    const data = snap.data();
    return fromStoredProfile(data?.profile ?? data);
  } catch (e) {
    console.error("[Firebase] getRemoteProfile 실패:", e);
    return null;
  }
}

/** Firestore에 프로필 저장 */
export async function setRemoteProfile(uid: string, info: MyInfo): Promise<boolean> {
  const ok = await ensureFirebase();
  const db = getDb();
  if (!ok || !db) return false;
  try {
    const ref = doc(db, USERS_COLLECTION, uid);
    const stored = toStoredProfile(info);
    await setDoc(ref, { profile: stored, updatedAt: serverTimestamp() }, { merge: true });
    return true;
  } catch (e) {
    console.error("[Firebase] setRemoteProfile 실패:", e);
    return false;
  }
}
