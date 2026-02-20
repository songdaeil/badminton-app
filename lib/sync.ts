"use client";

import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  where,
} from "firebase/firestore";
import type { GameData } from "@/lib/game-storage";
import { ensureFirebase, getDb } from "@/lib/firebase";

const COLLECTION = "sharedGames";
const USER_GAME_LIST_COLLECTION = "userGameLists";

/** UID별 경기 목록 항목 (id = 로컬 경기 id, shareId = Firestore 공유 문서 id) */
export interface GameListEntry {
  id: string;
  shareId: string | null;
}

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
      createdByUid: data.createdByUid ?? null,
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
      createdByUid: data.createdByUid ?? null,
    });
    return true;
  } catch (e) {
    console.error("[Firebase] setSharedGame 실패:", e);
    return false;
  }
}

/** Firestore에서 공유 경기 문서 삭제 (앱에서 경기 카드 삭제 시 호출) */
export async function deleteSharedGame(shareId: string): Promise<boolean> {
  const ok = await ensureFirebase();
  const db = getDb();
  if (!ok || !db) return false;
  try {
    const ref = doc(db, COLLECTION, shareId);
    await deleteDoc(ref);
    return true;
  } catch (e) {
    console.error("[Firebase] deleteSharedGame 실패:", e);
    return false;
  }
}

/** sharedGames 컬렉션에서 해당 UID가 만든 문서 id(shareId) 목록 조회.
 * 최상위 createdByUid가 없는 기존 문서는 gameData.createdByUid로 찾고, 한 번 최상위 필드를 채워 둠. */
export async function getSharedGameIdsByUid(uid: string): Promise<string[]> {
  const ok = await ensureFirebase();
  const db = getDb();
  if (!ok || !db) return [];
  try {
    const colRef = collection(db, COLLECTION);
    const q = query(colRef, where("createdByUid", "==", uid));
    const snap = await getDocs(q);
    const fromQuery = snap.docs.map((d) => d.id);
    if (fromQuery.length > 0) return fromQuery;

    // 쿼리 결과가 없으면 기존 문서(최상위 createdByUid 없음)일 수 있음 → gameData 내부로 폴백
    const allSnap = await getDocs(colRef);
    const matched: { id: string; needsMigration: boolean }[] = [];
    for (const d of allSnap.docs) {
      const data = d.data();
      const topUid = data.createdByUid;
      const innerUid = data?.gameData && typeof data.gameData === "object" ? (data.gameData as { createdByUid?: string }).createdByUid : undefined;
      const isMatch = topUid === uid || innerUid === uid;
      if (!isMatch) continue;
      matched.push({ id: d.id, needsMigration: topUid === undefined || topUid === null });
    }
    const ids = matched.map((m) => m.id);
    for (const { id, needsMigration } of matched) {
      if (needsMigration) {
        try {
          await setDoc(doc(db, COLLECTION, id), { createdByUid: uid }, { merge: true });
        } catch {
          // 무시: 다음 로드 시 다시 시도됨
        }
      }
    }
    return ids;
  } catch (e) {
    console.error("[Firebase] getSharedGameIdsByUid 실패:", e);
    return [];
  }
}

/** UID별 경기 목록 조회 */
export async function getUserGameList(uid: string): Promise<GameListEntry[]> {
  const ok = await ensureFirebase();
  const db = getDb();
  if (!ok || !db) return [];
  try {
    const ref = doc(db, USER_GAME_LIST_COLLECTION, uid);
    const snap = await getDoc(ref);
    if (!snap.exists()) return [];
    const data = snap.data();
    const list = data?.list;
    if (!Array.isArray(list)) return [];
    return list
      .filter((e: unknown) => e && typeof e === "object" && typeof (e as { id?: unknown }).id === "string")
      .map((e: { id: string; shareId?: string | null }) => ({
        id: e.id,
        shareId: typeof e.shareId === "string" ? e.shareId : null,
      }));
  } catch {
    return [];
  }
}

/** UID별 경기 목록 저장 */
export async function setUserGameList(uid: string, entries: GameListEntry[]): Promise<boolean> {
  const ok = await ensureFirebase();
  const db = getDb();
  if (!ok || !db) return false;
  try {
    const ref = doc(db, USER_GAME_LIST_COLLECTION, uid);
    await setDoc(ref, { list: entries, updatedAt: serverTimestamp() });
    return true;
  } catch (e) {
    console.error("[Firebase] setUserGameList 실패:", e);
    return false;
  }
}

function parseListFromDoc(data: unknown): GameListEntry[] {
  if (!data || typeof data !== "object") return [];
  const list = (data as { list?: unknown }).list;
  if (!Array.isArray(list)) return [];
  return list
    .filter((e: unknown) => e && typeof e === "object" && typeof (e as { id?: unknown }).id === "string")
    .map((e: { id: string; shareId?: string | null }) => ({
      id: e.id,
      shareId: typeof e.shareId === "string" ? e.shareId : null,
    }));
}

/** shareId 기준으로 중복 제거 (동일 shareId는 첫 항목만 유지). */
function dedupeByShareId(entries: GameListEntry[]): GameListEntry[] {
  const seen = new Set<string>();
  return entries.filter((e) => {
    if (e.shareId) {
      if (seen.has(e.shareId)) return false;
      seen.add(e.shareId);
    }
    return true;
  });
}

/** UID별 경기 목록을 트랜잭션으로 읽고, 전달한 목록과 id 기준 병합 후 저장. 동일 shareId는 1건만 유지. */
export async function mergeUserGameList(uid: string, entries: GameListEntry[]): Promise<boolean> {
  const ok = await ensureFirebase();
  const db = getDb();
  if (!ok || !db) return false;
  try {
    const ref = doc(db, USER_GAME_LIST_COLLECTION, uid);
    await runTransaction(db, async (transaction) => {
      const snap = await transaction.get(ref);
      const current = snap.exists() ? parseListFromDoc(snap.data()) : [];
      const byId = new Map<string, GameListEntry>(current.map((e) => [e.id, e]));
      for (const e of entries) byId.set(e.id, e);
      let merged = Array.from(byId.values());
      merged = dedupeByShareId(merged);
      transaction.set(ref, { list: merged, updatedAt: serverTimestamp() });
    });
    return true;
  } catch (e) {
    console.error("[Firebase] mergeUserGameList 실패:", e);
    return false;
  }
}

/** UID별 경기 목록 실시간 구독 */
export function subscribeUserGameList(
  uid: string,
  onData: (entries: GameListEntry[]) => void,
  onError?: (err: Error) => void
): (() => void) | null {
  const db = getDb();
  if (!db) return null;
  try {
    const ref = doc(db, USER_GAME_LIST_COLLECTION, uid);
    const unsub = onSnapshot(
      ref,
      (snap) => {
        if (!snap.exists()) {
          onData([]);
          return;
        }
        const list = snap.data()?.list;
        if (!Array.isArray(list)) {
          onData([]);
          return;
        }
        const entries: GameListEntry[] = list
          .filter((e: unknown) => e && typeof e === "object" && typeof (e as { id?: unknown }).id === "string")
          .map((e: { id: string; shareId?: string | null }) => ({
            id: e.id,
            shareId: typeof e.shareId === "string" ? e.shareId : null,
          }));
        onData(entries);
      },
      (err) => onError?.(err)
    );
    return () => unsub();
  } catch {
    return null;
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
