"use client";

import { useCallback, useEffect } from "react";
import { createGameId, loadGame, loadGameList, saveGame, saveGameList } from "@/lib/game-storage";
import {
  getSharedGame,
  getSharedGameIdsByUid,
  getUserGameList,
  isSyncAvailable,
  mergeUserGameList,
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
    getUserGameList(authUid)
      .then((remote) => {
        const localIds = loadGameList();
        const remoteMap = new Map(remote.map((e) => [e.id, e]));
        const merged: GameListEntry[] = [];
        for (const id of localIds) {
          merged.push(remoteMap.get(id) ?? { id, shareId: loadGame(id).shareId ?? null });
          remoteMap.delete(id);
        }
        for (const e of remoteMap.values()) merged.push(e);
        mergeUserGameList(authUid, merged).then((ok) => {
          if (ok) getUserGameList(authUid).then(applyList).catch(() => applyList(merged));
          else applyList(remote);
        }).catch(() => applyList(remote));
      })
      .catch(() => {});
    getSharedGameIdsByUid(authUid)
      .then((shareIds) => {
        const existingShareIds = new Set(
          loadGameList().map((id) => loadGame(id).shareId).filter((s): s is string => !!s)
        );
        const toAdd = shareIds.filter((s) => !existingShareIds.has(s));
        if (toAdd.length === 0) return;
        Promise.all(
          toAdd.map((shareId) =>
            getSharedGame(shareId).then((data) => {
              if (!data) return null;
              const newId = createGameId();
              saveGame(newId, { ...data, shareId });
              return newId;
            })
          )
        ).then((newIds) => {
          const added = newIds.filter((n): n is string => n != null);
          if (added.length === 0) return;
          const prev = loadGameList();
          saveGameList([...prev, ...added]);
          const toMerge: GameListEntry[] = [...prev, ...added].map((id) => ({
            id,
            shareId: loadGame(id).shareId ?? null,
          }));
          mergeUserGameList(authUid, toMerge).then((ok) => {
            if (ok) onListChange();
          });
        });
      })
      .catch(() => {});
    const unsub = subscribeUserGameList(authUid, applyList, () => {});
    return () => unsub?.();
  }, [authUid, onListChange, applyMerged]);

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
        const toAdd: GameListEntry = { id: addedId, shareId: loadGame(addedId).shareId ?? null };
        mergeUserGameList(authUid, [toAdd]).then((ok) => {
          if (ok) {
            getUserGameList(authUid).then(applyMerged).catch(() => {});
          }
        }).catch(() => {});
        return;
      }
      const localIds = loadGameList();
      const toMerge: GameListEntry[] = localIds.map((id) => ({
        id,
        shareId: loadGame(id).shareId ?? null,
      }));
      mergeUserGameList(authUid, toMerge).then((ok) => {
        if (ok) {
          getUserGameList(authUid).then(applyMerged).catch(() => {});
        }
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
