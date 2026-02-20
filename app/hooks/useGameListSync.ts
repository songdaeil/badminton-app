"use client";

import { useCallback, useEffect } from "react";
import { loadGame, loadGameList, saveGame, saveGameList } from "@/lib/game-storage";
import {
  getSharedGame,
  getUserGameList,
  isSyncAvailable,
  setUserGameList,
  subscribeUserGameList,
} from "@/lib/sync";
import type { GameListEntry } from "@/lib/sync";

/**
 * 로그인 UID 기준 경기 목록을 Firestore와 동기화.
 * - 로그인 시 원격 목록 불러오기 + 실시간 구독(다른 기기 추가/삭제 즉시 반영)
 * - syncGameListToFirebase: 목록 추가/삭제 시 원격과 병합 후 업로드
 * - refreshListFromRemote: 당겨서 새로고침 등에서 Firestore 목록 다시 불러오기
 */
export function useGameListSync(
  authUid: string | null,
  onListChange: () => void
): {
  syncGameListToFirebase: (opts?: { added?: string; removed?: string }) => void;
  refreshListFromRemote: () => void;
} {
  const applyMerged = useCallback(
    (entries: GameListEntry[]) => {
      saveGameList(entries.map((e) => e.id));
      onListChange();
    },
    [onListChange]
  );

  useEffect(() => {
    if (!authUid || typeof window === "undefined" || !isSyncAvailable()) return;
    const applyList = (entries: GameListEntry[]) => {
      saveGameList(entries.map((e) => e.id));
      onListChange();
      entries.forEach((e) => {
        if (e.shareId && !loadGame(e.id)?.members?.length) {
          getSharedGame(e.shareId).then((data) => {
            if (data) {
              saveGame(e.id, { ...data, shareId: e.shareId ?? undefined });
              onListChange();
            }
          }).catch(() => {});
        }
      });
    };
    getUserGameList(authUid).then(applyList).catch(() => {});
    const unsub = subscribeUserGameList(authUid, applyList, () => {});
    return () => unsub?.();
  }, [authUid, onListChange]);

  const syncGameListToFirebase = useCallback(
    (opts?: { added?: string; removed?: string }) => {
      if (!authUid || !isSyncAvailable()) return;
      if (opts?.removed != null) {
        getUserGameList(authUid).then((remote) => {
          const merged = remote.filter((e) => e.id !== opts.removed);
          setUserGameList(authUid, merged).catch(() => {});
        }).catch(() => {});
        return;
      }
      if (opts?.added != null) {
        const addedId: string = opts.added;
        getUserGameList(authUid).then((remote) => {
          if (remote.some((e) => e.id === addedId)) {
            applyMerged(remote);
            return;
          }
          const merged: GameListEntry[] = [
            ...remote,
            { id: addedId, shareId: loadGame(addedId).shareId ?? null },
          ];
          setUserGameList(authUid, merged).then((ok) => {
            if (ok) applyMerged(merged);
          }).catch(() => {});
        }).catch(() => {});
        return;
      }
      getUserGameList(authUid).then((remote) => {
        const localIds = loadGameList();
        const remoteMap = new Map(remote.map((e) => [e.id, e]));
        const merged: GameListEntry[] = [];
        for (const id of localIds) {
          merged.push(remoteMap.get(id) ?? { id, shareId: loadGame(id).shareId ?? null });
          remoteMap.delete(id);
        }
        for (const e of remoteMap.values()) merged.push(e);
        setUserGameList(authUid, merged).then((ok) => {
          if (ok) applyMerged(merged);
        }).catch(() => {});
      }).catch(() => {});
    },
    [authUid, applyMerged]
  );

  const refreshListFromRemote = useCallback(() => {
    if (!authUid || !isSyncAvailable()) {
      onListChange();
      return;
    }
    getUserGameList(authUid).then(applyMerged).catch(() => onListChange());
  }, [authUid, applyMerged, onListChange]);

  return { syncGameListToFirebase, refreshListFromRemote };
}
