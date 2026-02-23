"use client";

import { useCallback, useEffect, useRef } from "react";
import { createGameId, loadGame, loadGameList, saveGame, saveGameList } from "@/lib/game-storage";
import {
  getSharedGame,
  getSharedGameIdsByUid,
  getUserGameList,
  isSyncAvailable,
  mergeUserGameList,
  setUserGameList,
  subscribeSharedGame,
  subscribeUserGameList,
} from "@/lib/sync";
import type { GameListEntry } from "@/lib/sync";

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

/** 서버 목록을 로컬 id로 해석: shareId별 로컬 id 매핑, 없으면 fetch 후 생성. 중복 id 제거. */
async function resolveToLocalEntries(entries: GameListEntry[]): Promise<GameListEntry[]> {
  const deduped = dedupeByShareId(entries);
  const result: GameListEntry[] = [];
  const seenLocalId = new Set<string>();
  for (const e of deduped) {
    if (e.shareId) {
      let localId = loadGameList().find((id) => loadGame(id).shareId === e.shareId);
      if (!localId) {
        const data = await getSharedGame(e.shareId);
        if (!data) continue;
        localId = createGameId();
        saveGame(localId, { ...data, shareId: e.shareId });
      }
      if (seenLocalId.has(localId)) continue;
      seenLocalId.add(localId);
      result.push({ id: localId, shareId: e.shareId });
    } else {
      const game = loadGame(e.id);
      if (!game) continue;
      if (game.shareId && result.some((r) => r.shareId === game.shareId)) continue;
      if (seenLocalId.has(e.id)) continue;
      seenLocalId.add(e.id);
      result.push(e);
    }
  }
  return result;
}

/**
 * 로그인 UID 기준 경기 목록을 Firestore와 동기화.
 * - Firebase userGameLists를 단일 소스로 적용, shareId 기준 중복 제거·로컬 id 해석
 * - 목록/공유 경기 실시간 구독으로 다른 기기 편집 즉시 반영
 */
export function useGameListSync(
  authUid: string | null,
  onListChange: () => void
): {
  syncGameListToFirebase: (opts?: { added?: string; removed?: string; removedShareId?: string }) => void;
  refreshListFromRemote: () => void;
} {
  const unsubSharedRef = useRef<(() => void)[]>([]);

  const applyResolvedList = useCallback(
    (resolved: GameListEntry[]) => {
      const localIdsBefore = loadGameList();
      const resolvedShareIds = new Set(resolved.map((e) => e.shareId).filter((s): s is string => !!s));
      const toSubscribe: GameListEntry[] = [...resolved];
      for (const id of localIdsBefore) {
        const shareId = loadGame(id)?.shareId;
        if (shareId && !resolvedShareIds.has(shareId)) {
          resolvedShareIds.add(shareId);
          toSubscribe.push({ id, shareId });
        }
      }
      saveGameList(resolved.map((e) => e.id));
      onListChange();
      unsubSharedRef.current.forEach((u) => u());
      unsubSharedRef.current = [];
      toSubscribe.forEach((e) => {
        if (!e.shareId) return;
        const unsub = subscribeSharedGame(e.shareId, (data) => {
          saveGame(e.id, { ...data, shareId: e.shareId ?? undefined });
          onListChange();
        });
        if (unsub) unsubSharedRef.current.push(unsub);
      });
    },
    [onListChange]
  );

  const handleServerList = useCallback(
    (entries: GameListEntry[]) => {
      const localIds = loadGameList();
      if (entries.length === 0 && localIds.length > 0) {
        const toMerge: GameListEntry[] = localIds.map((id) => ({
          id,
          shareId: loadGame(id)?.shareId ?? null,
        }));
        mergeUserGameList(authUid!, toMerge).then(() => {});
        return;
      }
      resolveToLocalEntries(entries).then(applyResolvedList).catch(() => {});
    },
    [authUid, applyResolvedList]
  );

  /** 현재 로컬 목록 기준으로 공유 경기(shareId) 구독만 갱신. 목록 저장은 하지 않음. 탭 포커스 시 실시간 동기화 복구용 */
  const ensureSubscriptionsForCurrentList = useCallback(() => {
    if (!isSyncAvailable()) return;
    const ids = loadGameList();
    const entries: GameListEntry[] = ids
      .map((id) => ({ id, shareId: loadGame(id)?.shareId ?? null }))
      .filter((e): e is GameListEntry & { shareId: string } => !!e.shareId);
    if (entries.length === 0) {
      unsubSharedRef.current.forEach((u) => u());
      unsubSharedRef.current = [];
      return;
    }
    unsubSharedRef.current.forEach((u) => u());
    unsubSharedRef.current = [];
    entries.forEach((e) => {
      const shareId = e.shareId;
      if (!shareId) return;
      const unsub = subscribeSharedGame(shareId, (data) => {
        saveGame(e.id, { ...data, shareId });
        onListChange();
      });
      if (unsub) unsubSharedRef.current.push(unsub);
    });
  }, [onListChange]);

  useEffect(() => {
    if (!authUid || typeof window === "undefined" || !isSyncAvailable()) return;

    getUserGameList(authUid)
      .then((remote) => {
        const deduped = dedupeByShareId(remote);
        const localIds = loadGameList();
        if (deduped.length === 0 && localIds.length > 0) {
          const toMerge: GameListEntry[] = localIds.map((id) => ({
            id,
            shareId: loadGame(id)?.shareId ?? null,
          }));
          return mergeUserGameList(authUid, toMerge).then(() => {});
        }
        return resolveToLocalEntries(deduped).then((resolved) => {
          applyResolvedList(resolved);
          mergeUserGameList(authUid, resolved).then(() => {});
        });
      })
      .catch(() => {});

    getSharedGameIdsByUid(authUid)
      .then((shareIds) => {
        getUserGameList(authUid).then((remote) => {
          const existingShareIds = new Set(
            dedupeByShareId(remote).map((e) => e.shareId).filter((s): s is string => !!s)
          );
          const toAdd = shareIds.filter((s) => !existingShareIds.has(s));
          if (toAdd.length === 0) return;
          Promise.all(
            toAdd.map((shareId) =>
              getSharedGame(shareId).then((data) => (data ? { shareId, data } : null))
            )
          ).then((results) => {
            const newEntries: GameListEntry[] = [];
            results.forEach((r) => {
              if (!r) return;
              const newId = createGameId();
              saveGame(newId, { ...r.data, shareId: r.shareId });
              newEntries.push({ id: newId, shareId: r.shareId });
            });
            if (newEntries.length === 0) return;
            mergeUserGameList(authUid, newEntries).then((ok) => {
              if (ok) getUserGameList(authUid).then(handleServerList).catch(() => {});
            });
          });
        });
      })
      .catch(() => {});

    const unsub = subscribeUserGameList(authUid, handleServerList, () => {});

    const onFocus = () => ensureSubscriptionsForCurrentList();
    if (typeof window !== "undefined") {
      window.addEventListener("focus", onFocus);
    }

    return () => {
      unsub?.();
      if (typeof window !== "undefined") {
        window.removeEventListener("focus", onFocus);
      }
      unsubSharedRef.current.forEach((u) => u());
      unsubSharedRef.current = [];
    };
  }, [authUid, handleServerList, applyResolvedList, ensureSubscriptionsForCurrentList]);

  const syncGameListToFirebase = useCallback(
    (opts?: { added?: string; removed?: string }) => {
      if (!authUid || !isSyncAvailable()) return;
      if (opts?.removed != null) {
        const removedId = opts.removed;
        const removedShareId = opts.removedShareId;
        getUserGameList(authUid).then((remote) => {
          const filtered = remote.filter(
            (e) => e.id !== removedId && !(removedShareId && e.shareId === removedShareId)
          );
          setUserGameList(authUid, dedupeByShareId(filtered)).catch(() => {});
        }).catch(() => {});
        return;
      }
      if (opts?.added != null) {
        const addedId: string = opts.added;
        const toAdd: GameListEntry = { id: addedId, shareId: loadGame(addedId).shareId ?? null };
        mergeUserGameList(authUid, [toAdd]).catch(() => {});
        return;
      }
      const localIds = loadGameList();
      const toMerge: GameListEntry[] = localIds.map((id) => ({
        id,
        shareId: loadGame(id).shareId ?? null,
      }));
      mergeUserGameList(authUid, toMerge).catch(() => {});
    },
    [authUid]
  );

  const refreshListFromRemote = useCallback(() => {
    if (!authUid || !isSyncAvailable()) {
      onListChange();
      return;
    }
    getUserGameList(authUid).then((entries) => {
      resolveToLocalEntries(dedupeByShareId(entries)).then(applyResolvedList).catch(() => onListChange());
    }).catch(() => onListChange());
  }, [authUid, onListChange, applyResolvedList]);

  return { syncGameListToFirebase, refreshListFromRemote };
}
