"use client";

import {
  addDoc,
  collection,
  doc,
  getDoc,
  onSnapshot,
  serverTimestamp,
  setDoc,
} from "firebase/firestore";
import type { GameData } from "@/lib/game-storage";
import { ensureFirebase, getDb } from "@/lib/firebase";

const COLLECTION = "sharedGames";

/** Firestore는 undefined 미지원. JSON 직렬화로 깊은 복사 후 undefined → null 치환해 데이터 누락 방지 */
function toStoredData(data: GameData): Record<string, unknown> {
  const { shareId: _, ...rest } = data;
  const json = JSON.stringify(rest, (_key, value) => (value === undefined ? null : value));
  return JSON.parse(json) as Record<string, unknown>;
}

/** Firestore 업로드 시 전송되는 문서의 대략적인 크기(바이트). gameData + updatedAt 필드 기준 UTF-8 길이 */
export function getFirestorePayloadSize(data: GameData): number {
  const doc = { gameData: toStoredData(data), updatedAt: null };
  const json = JSON.stringify(doc);
  return new TextEncoder().encode(json).length;
}

function fromStored(shareId: string, raw: unknown): GameData | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (!Array.isArray(o.members) || !Array.isArray(o.matches)) return null;
  return { ...o, members: o.members, matches: o.matches, shareId } as GameData;
}

export function isSyncAvailable(): boolean {
  return getDb() != null;
}

export async function getSharedGame(shareId: string): Promise<GameData | null> {
  const ok = await ensureFirebase();
  const db = getDb();
  if (!ok || !db) return null;
  try {
    const ref = doc(db, COLLECTION, shareId);
    const snap = await getDoc(ref);
    if (!snap.exists()) return null;
    const data = snap.data();
    return fromStored(shareId, data?.gameData);
  } catch {
    return null;
  }
}

/** sharedGames 컬렉션에 addDoc으로 새 문서 추가. 반환: 새 문서 id (실패 시 null) */
export async function addSharedGame(data: GameData): Promise<string | null> {
  const ok = await ensureFirebase();
  const db = getDb();
  if (!ok || !db) {
    console.warn("[Firebase] addSharedGame: 초기화되지 않음. .env.local 확인 후 서버 재시작.");
    return null;
  }
  try {
    const payload = toStoredData(data);
    const size = getFirestorePayloadSize(data);
    if (typeof process !== "undefined" && process.env.NODE_ENV === "development") {
      console.log("[Firebase] 업로드 용량:", size, "bytes", `(${(size / 1024).toFixed(2)} KB)`);
    }
    const colRef = collection(db, COLLECTION);
    const docRef = await addDoc(colRef, {
      gameData: payload,
      updatedAt: serverTimestamp(),
    });
    return docRef.id;
  } catch (e) {
    console.error("[Firebase] addSharedGame 실패:", e);
    return null;
  }
}

export async function setSharedGame(shareId: string, data: GameData): Promise<boolean> {
  const ok = await ensureFirebase();
  const db = getDb();
  if (!ok || !db) return false;
  try {
    const payload = toStoredData(data);
    const size = getFirestorePayloadSize(data);
    if (typeof process !== "undefined" && process.env.NODE_ENV === "development") {
      console.log("[Firebase] 업로드 용량:", size, "bytes", `(${(size / 1024).toFixed(2)} KB)`);
    }
    const ref = doc(db, COLLECTION, shareId);
    await setDoc(ref, {
      gameData: payload,
      updatedAt: serverTimestamp(),
    });
    return true;
  } catch (e) {
    console.error("[Firebase] setSharedGame 실패:", e);
    return false;
  }
}

/** 구독 해제 함수 */
export function subscribeSharedGame(
  shareId: string,
  onData: (data: GameData) => void,
  onError?: (err: Error) => void
): (() => void) | null {
  const db = getDb();
  if (!db) return null;
  try {
    const ref = doc(db, COLLECTION, shareId);
    const unsub = onSnapshot(
      ref,
      (snap) => {
        if (!snap.exists()) return;
        const gameData = fromStored(shareId, snap.data()?.gameData);
        if (gameData) onData(gameData);
      },
      (err) => onError?.(err)
    );
    return () => unsub();
  } catch {
    return null;
  }
}
