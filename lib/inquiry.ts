"use client";

import { addDoc, collection, serverTimestamp } from "firebase/firestore";
import { ensureFirebase, getDb } from "@/lib/firebase";

const COLLECTION = "inquiries";

export type SubmitInquiryResult = { ok: true } | { ok: false; error: string };

/** 문의 내용을 Firestore inquiries 컬렉션에 저장. 관리자가 콘솔 또는 별도 화면에서 확인 가능 */
export async function submitInquiry(params: {
  content: string;
  userId?: string | null;
  userEmail?: string | null;
  userName?: string | null;
}): Promise<SubmitInquiryResult> {
  const ok = await ensureFirebase();
  const db = getDb();
  if (!ok || !db) {
    return { ok: false, error: "연결할 수 없습니다. 잠시 후 다시 시도해 주세요." };
  }
  const trimmed = params.content?.trim();
  if (!trimmed) {
    return { ok: false, error: "문의 내용을 입력해 주세요." };
  }
  try {
    const colRef = collection(db, COLLECTION);
    await addDoc(colRef, {
      content: trimmed,
      userId: params.userId ?? null,
      userEmail: params.userEmail ?? null,
      userName: params.userName ?? null,
      createdAt: serverTimestamp(),
    });
    return { ok: true };
  } catch (e) {
    console.error("[inquiry] submit error:", e);
    return { ok: false, error: "업로드에 실패했습니다. 다시 시도해 주세요." };
  }
}
