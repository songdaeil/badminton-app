"use client";

import { deleteUser } from "firebase/auth";
import { deleteDoc, doc } from "firebase/firestore";
import { ensureFirebase, getAuthInstance, getDb } from "@/lib/firebase";
import { deleteSharedGame, getSharedGameIdsByUid } from "@/lib/sync";

const USERS_COLLECTION = "users";
const USER_GAME_LIST_COLLECTION = "userGameLists";

/** 이 계정 프로필·목록·내가 만든 공유 경기·Auth를 지운다. 최근 로그인이 필요하면 실패 메시지를 반환한다. */
export async function deleteCurrentAccount(): Promise<{ ok: boolean; message?: string }> {
  const ok = await ensureFirebase();
  const auth = getAuthInstance();
  const db = getDb();
  const user = auth?.currentUser;
  if (!ok || !auth || !db || !user) {
    return { ok: false, message: "로그인이 필요합니다." };
  }
  const uid = user.uid;
  try {
    const shareIds = await getSharedGameIdsByUid(uid);
    for (const shareId of shareIds) {
      await deleteSharedGame(shareId);
    }
    await deleteDoc(doc(db, USER_GAME_LIST_COLLECTION, uid)).catch(() => {});
    await deleteDoc(doc(db, USERS_COLLECTION, uid)).catch(() => {});
    await deleteUser(user);
    return { ok: true };
  } catch (e: unknown) {
    const code = e && typeof e === "object" && "code" in e ? (e as { code: string }).code : "";
    if (code === "auth/requires-recent-login") {
      return { ok: false, message: "보안을 위해 다시 로그인 한 뒤 탈퇴해 주세요." };
    }
    return { ok: false, message: e instanceof Error ? e.message : "탈퇴에 실패했습니다." };
  }
}
