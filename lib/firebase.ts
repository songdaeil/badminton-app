"use client";

/**
 * 환경 변수를 사용해서 Firebase를 초기화합니다.
 * .env.local에 NEXT_PUBLIC_FIREBASE_* 값이 설정되어 있어야 합니다.
 */

import { getApp, getApps, initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};

let db: ReturnType<typeof getFirestore> | null = null;

function initFirebase(): boolean {
  if (db) return true;
  if (typeof window === "undefined") return false;
  if (!firebaseConfig.apiKey || !firebaseConfig.projectId) {
    console.warn("[Firebase] .env.local에 NEXT_PUBLIC_FIREBASE_API_KEY, NEXT_PUBLIC_FIREBASE_PROJECT_ID 가 필요합니다.");
    return false;
  }
  try {
    const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
    db = getFirestore(app);
    return true;
  } catch (e) {
    console.error("[Firebase] 초기화 실패:", e);
    return false;
  }
}

export function isSyncAvailable(): boolean {
  return db != null;
}

export async function ensureFirebase(): Promise<boolean> {
  return Promise.resolve(initFirebase());
}

export function getDb(): ReturnType<typeof getFirestore> | null {
  return db;
}
