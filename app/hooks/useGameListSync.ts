"use client";

/**
 * 경기 목록 동기화 (한 줄 요약)
 * - 소스: Firebase userGameLists/{uid} 단일 소스.
 * - 계정 전환: 로컬 목록 비우기 → 서버에서 목록 가져와 적용.
 * - 적용: 서버 항목을 로컬 id로 해석 → 로컬 저장 → 공유 경기 실시간 구독.
 */

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

/** 서버 항목 → 로컬 id 해석 (shareId면 fetch 후 매핑, 중복 제거) */
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

export function useGameListSync(
  authUid: string | null,
  onListChange: () => void
): {
  syncGameListToFirebase: (opts?: { added?: string; removed?: string; removedShareId?: string }) => void;
  refreshListFromRemote: () => void;
} {
  const unsubSharedRef = useRef<(() => void)[]>([]);
  const prevAuthUidRef = useRef<string | null>(null);

  /** 해석된 목록을 로컬에 저장하고, 공유 경기만 실시간 구독 */
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

  /** [단일 진입점] 서버에서 받은 목록 → 해석 → 로컬 적용. 초기 로드·구독 모두 이걸로 처리 */
  const applyServerList = useCallback(
    (entries: GameListEntry[]) => {
      resolveToLocalEntries(entries)
        .then((resolved) => {
          if (resolved.length === 0 && authUid) setUserGameList(authUid, []).catch(() => {});
          applyResolvedList(resolved);
        })
        .catch(() => {});
    },
    [authUid, applyResolvedList]
  );

  /** 탭 포커스 시: 현재 로컬 목록의 공유 경기 구독만 다시 연결 */
  const ensureSubscriptionsForCurrentList = useCallback(() => {
    if (!isSyncAvailable()) return;
    const ids = loadGameList();
    const entries: GameListEntry[] = ids
      .map((id) => ({ id, shareId: loadGame(id)?.shareId ?? null }))
      .filter((e): e is GameListEntry & { shareId: string } => !!e.shareId);
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

    if (prevAuthUidRef.current !== authUid) {
      prevAuthUidRef.current = authUid;
      saveGameList([]);
      onListChange();
    }

    // 1) 서버 목록 한 번 가져와서 적용 (구독이 곧바로 최신으로 덮어씀)
    getUserGameList(authUid).then(applyServerList).catch(() => {});

    // 2) "내가 만든 공유 경기" 중 목록에 없는 것만 Firebase에 추가 → 구독으로 반영
    getSharedGameIdsByUid(authUid)
      .then((shareIds) => {
        getUserGameList(authUid).then((remote) => {
          const existing = new Set(
            dedupeByShareId(remote).map((e) => e.shareId).filter((s): s is string => !!s)
          );
          const toAdd = shareIds.filter((s) => !existing.has(s));
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
            if (newEntries.length > 0) mergeUserGameList(authUid, newEntries).catch(() => {});
          });
        });
      })
      .catch(() => {});

    const unsub = subscribeUserGameList(authUid, applyServerList, () => {});

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
  }, [authUid, applyServerList, ensureSubscriptionsForCurrentList]);

  const syncGameListToFirebase = useCallback(
    (opts?: { added?: string; removed?: string; removedShareId?: string }) => {
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
    getUserGameList(authUid).then(applyServerList).catch(() => onListChange());
  }, [authUid, onListChange, applyServerList]);

  return { syncGameListToFirebase, refreshListFromRemote };
}
