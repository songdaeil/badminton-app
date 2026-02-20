import type { GameData } from "@/lib/game-storage";
import { DEFAULT_GAME_SETTINGS } from "@/lib/game-storage";

/** 공유 링크용 경기 데이터 직렬화 (base64url) - 만든 이 정보 포함 */
export function encodeGameForShare(data: GameData): string {
  const payload = {
    members: data.members,
    matches: data.matches,
    gameName: data.gameName ?? undefined,
    gameMode: data.gameMode,
    gameSettings: data.gameSettings ?? DEFAULT_GAME_SETTINGS,
    myProfileMemberId: data.myProfileMemberId ?? undefined,
    createdAt: data.createdAt ?? undefined,
    createdBy: data.createdBy ?? undefined,
    createdByName: data.createdByName ?? undefined,
    createdByUid: data.createdByUid ?? undefined,
  };
  const json = JSON.stringify(payload);
  const base64 = btoa(encodeURIComponent(json));
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** 공유 링크에서 경기 데이터 복원 */
export function decodeGameFromShare(encoded: string): GameData | null {
  try {
    const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    const json = decodeURIComponent(atob(padded));
    const p = JSON.parse(json) as GameData;
    if (!p || !Array.isArray(p.members) || !Array.isArray(p.matches)) return null;
    return {
      members: p.members,
      matches: p.matches,
      gameName: p.gameName ?? undefined,
      gameMode: p.gameMode,
      gameSettings: p.gameSettings ?? { ...DEFAULT_GAME_SETTINGS },
      myProfileMemberId: p.myProfileMemberId ?? undefined,
      createdAt: typeof p.createdAt === "string" ? p.createdAt : undefined,
      createdBy: typeof p.createdBy === "string" ? p.createdBy : undefined,
      createdByName: typeof p.createdByName === "string" ? p.createdByName : undefined,
      createdByUid: typeof p.createdByUid === "string" ? p.createdByUid : undefined,
    };
  } catch {
    return null;
  }
}
