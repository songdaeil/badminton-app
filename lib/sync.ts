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
import type { Match, Member, SavedRecord } from "@/app/types";
import { ensureFirebase, getAuthInstance, getDb } from "@/lib/firebase";

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

function matchHasScore(m: Match): boolean {
  return m.score1 != null || m.score2 != null;
}

function mergeSavedHistory(a?: SavedRecord[], b?: SavedRecord[]): SavedRecord[] {
  const all = [...(a ?? []), ...(b ?? [])];
  const seen = new Set<string>();
  const out: SavedRecord[] = [];
  for (const r of all) {
    if (!r?.at) continue;
    const key = `${r.at}|${r.by ?? ""}|${r.savedByName ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  out.sort((x, y) => (x.at ?? "").localeCompare(y.at ?? ""));
  return out;
}

function scoresDiffer(a: Match, b: Match): boolean {
  return a.score1 !== b.score1 || a.score2 !== b.score2;
}

function pickMatch(remote: Match | undefined, local: Match | undefined, isOwner: boolean): Match | undefined {
  if (!remote) return local;
  if (!local) return remote;
  const remoteSaved = matchHasScore(remote);
  const localSaved = matchHasScore(local);
  if (remoteSaved && localSaved && scoresDiffer(remote, local) && !isOwner) {
    return { ...remote, savedHistory: mergeSavedHistory(remote.savedHistory, local.savedHistory) };
  }
  let winner: Match;
  if (localSaved && !remoteSaved) winner = local;
  else if (remoteSaved && !localSaved) winner = remote;
  else if (localSaved && remoteSaved) {
    const lt = local.savedAt ?? "";
    const rt = remote.savedAt ?? "";
    winner = lt >= rt ? local : remote;
  } else {
    winner = local;
  }
  return { ...winner, savedHistory: mergeSavedHistory(remote.savedHistory, local.savedHistory) };
}

function mergeMatches(remote: Match[], local: Match[], isOwner: boolean): Match[] {
  const remoteIds = new Set(remote.map((m) => m.id));
  let overlap = 0;
  for (const m of local) if (remoteIds.has(m.id)) overlap += 1;
  if (isOwner && local.length > 0 && remote.length > 0 && overlap === 0) {
    return local;
  }
  if (!isOwner) {
    return remote.map((rm) => pickMatch(rm, local.find((lm) => lm.id === rm.id), false) ?? rm);
  }
  const byId = new Map<string, Match>();
  for (const m of remote) byId.set(m.id, m);
  for (const m of local) {
    const picked = pickMatch(byId.get(m.id), m, true);
    if (picked) byId.set(m.id, picked);
  }
  const orderSrc = local.length >= remote.length ? local : remote;
  const matches: Match[] = [];
  const seen = new Set<string>();
  for (const m of orderSrc) {
    matches.push(byId.get(m.id) ?? m);
    seen.add(m.id);
  }
  for (const m of byId.values()) {
    if (!seen.has(m.id)) matches.push(m);
  }
  return matches;
}

function mergeMembers(remote: Member[], local: Member[], isOwner: boolean, editorUid?: string | null): Member[] {
  if (isOwner) {
    const remoteById = new Map(remote.map((m) => [m.id, m]));
    const localLinked = new Set(local.map((m) => m.linkedUid).filter((u): u is string => Boolean(u)));
    const merged = local.map((lm) => {
      const rm = remoteById.get(lm.id);
      return rm ? { ...rm, ...lm, linkedUid: lm.linkedUid ?? rm.linkedUid } : lm;
    });
    const localIds = new Set(merged.map((m) => m.id));
    for (const rm of remote) {
      if (rm.linkedUid && !localLinked.has(rm.linkedUid) && !localIds.has(rm.id)) {
        merged.push(rm);
        localIds.add(rm.id);
      }
    }
    return merged;
  }
  const result = [...remote];
  if (!editorUid) return result;
  const localSelf = local.filter((m) => m.linkedUid === editorUid);
  if (localSelf.length === 0) {
    return result.filter((m) => m.linkedUid !== editorUid);
  }
  for (const self of localSelf) {
    const idx = result.findIndex((m) => m.id === self.id || m.linkedUid === editorUid);
    if (idx >= 0) {
      result[idx] = { ...result[idx], ...self, linkedUid: editorUid };
    } else {
      result.push(self);
    }
  }
  return result;
}

/** 동시 저장 시 매치 점수는 savedAt이 늦은 쪽. 요약·대진 구조는 만든이만, 참여자는 본인 명단·점수만 반영. */
export function mergeGameData(remote: GameData, local: GameData, editorUid?: string | null): GameData {
  const ownerUid = remote.createdByUid ?? local.createdByUid;
  const isOwner = Boolean(editorUid && ownerUid && editorUid === ownerUid);
  const matches = mergeMatches(remote.matches ?? [], local.matches ?? [], isOwner);
  const members = mergeMembers(remote.members ?? [], local.members ?? [], isOwner, editorUid);

  const scoredIds = new Set(matches.filter(matchHasScore).map((m) => m.id));
  const remotePlayAt = remote.playingUpdatedAt ?? "";
  const localPlayAt = local.playingUpdatedAt ?? "";
  const playingSrc =
    localPlayAt || remotePlayAt
      ? (localPlayAt >= remotePlayAt ? local : remote)
      : local;
  const playing = [...new Set(playingSrc.playingMatchIds ?? [])].filter((id) => !scoredIds.has(id));

  return {
    ...remote,
    members,
    matches,
    playingMatchIds: playing,
    playingUpdatedAt: playingSrc.playingUpdatedAt ?? remote.playingUpdatedAt ?? local.playingUpdatedAt,
    createdAt: remote.createdAt ?? local.createdAt,
    createdBy: remote.createdBy ?? local.createdBy,
    createdByName: remote.createdByName ?? local.createdByName,
    createdByUid: remote.createdByUid ?? local.createdByUid,
    shareId: local.shareId ?? remote.shareId,
    gameName: isOwner && local.gameName?.trim() ? local.gameName : remote.gameName,
    gameMode: isOwner ? (local.gameMode ?? remote.gameMode) : remote.gameMode,
    gameSettings: isOwner ? (local.gameSettings ?? remote.gameSettings) : remote.gameSettings,
    myProfileMemberId: isOwner ? (local.myProfileMemberId ?? remote.myProfileMemberId) : remote.myProfileMemberId,
  };
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

export interface SharedGameWriteResult {
  ok: boolean;
  conflicts: string[];
}

export async function setSharedGame(shareId: string, data: GameData): Promise<SharedGameWriteResult> {
  const ok = await ensureFirebase();
  const db = getDb();
  if (!ok || !db) return { ok: false, conflicts: [] };
  const conflicts: string[] = [];
  try {
    const ref = doc(db, COLLECTION, shareId);
    await runTransaction(db, async (transaction) => {
      const snap = await transaction.get(ref);
      let merged: GameData = data;
      if (snap.exists()) {
        const remote = fromStored(shareId, snap.data()?.gameData);
        const editorUid = getAuthInstance()?.currentUser?.uid ?? null;
        const ownerUid = remote?.createdByUid ?? data.createdByUid;
        const isOwner = Boolean(editorUid && ownerUid && editorUid === ownerUid);
        if (remote) {
          conflicts.length = 0;
          for (const lm of data.matches ?? []) {
            if (!matchHasScore(lm)) continue;
            const rm = (remote.matches ?? []).find((m) => m.id === lm.id);
            if (rm && matchHasScore(rm) && scoresDiffer(rm, lm) && !isOwner) {
              conflicts.push(lm.id);
            }
          }
          merged = mergeGameData(remote, data, editorUid);
        }
      }
      const payload = toStoredData(merged);
      const size = getFirestorePayloadSize(merged);
      if (typeof process !== "undefined" && process.env.NODE_ENV === "development") {
        console.log("[Firebase] 업로드 용량:", size, "bytes", `(${(size / 1024).toFixed(2)} KB)`);
      }
      transaction.set(ref, {
        gameData: payload,
        updatedAt: serverTimestamp(),
        createdByUid: merged.createdByUid ?? data.createdByUid ?? snap.data()?.createdByUid ?? null,
      });
    });
    return { ok: true, conflicts };
  } catch (e) {
    console.error("[Firebase] setSharedGame 실패:", e);
    return { ok: false, conflicts: [] };
  }
}

/** 공유 경기 데이터일 때만 Firestore에 업로드. shareId 없거나 sync 불가 시 아무 작업 안 함. */
export function uploadSharedGameIfNeeded(data: GameData): Promise<SharedGameWriteResult | void> {
  if (!data.shareId || !isSyncAvailable()) return Promise.resolve();
  return setSharedGame(data.shareId, data);
}

/** 공유 경기인데 payload가 비어 있고 기존 데이터가 있으면 업로드 스킵 (데이터 유실 방지). */
export function shouldSkipSharedGameUpload(payload: GameData, localBefore?: GameData): boolean {
  if (!payload.shareId) return false;
  const payloadEmpty = (payload.members?.length ?? 0) === 0 && (payload.matches?.length ?? 0) === 0;
  if (!payloadEmpty) return false;
  if (!localBefore) return false;
  return (localBefore.members?.length ?? 0) > 0 || (localBefore.matches?.length ?? 0) > 0;
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
    return fromQuery;
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

/** 해당 uid의 경기 목록(만든 경기 + 참여한 경기) 반환 */
export async function getGameListForUid(uid: string): Promise<GameListEntry[]> {
  const [list, createdShareIds] = await Promise.all([
    getUserGameList(uid),
    getSharedGameIdsByUid(uid),
  ]);
  const mine: GameListEntry[] = [...list];
  // createdByUid로 찾은 공유 경기 중 목록에 없는 것 추가
  const existingShareIds = new Set(mine.map((e) => e.shareId).filter((s): s is string => typeof s === "string" && s.length > 0));
  for (const shareId of createdShareIds) {
    if (!existingShareIds.has(shareId)) {
      mine.push({ id: shareId, shareId });
      existingShareIds.add(shareId);
    }
  }
  return mine;
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

/** 구독 해제 함수. 문서가 삭제되면 onDeleted를 한 번 호출한다. */
export function subscribeSharedGame(
  shareId: string,
  onData: (data: GameData) => void,
  onError?: (err: Error) => void,
  onDeleted?: () => void
): (() => void) | null {
  const db = getDb();
  if (!db) return null;
  try {
    const ref = doc(db, COLLECTION, shareId);
    const unsub = onSnapshot(
      ref,
      (snap) => {
        if (!snap.exists()) {
          onDeleted?.();
          return;
        }
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
