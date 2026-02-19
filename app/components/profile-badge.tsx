"use client";

import { useState } from "react";

type Grade = "A" | "B" | "C" | "D";

export interface ProfileBadgeProps {
  /** 아바타 뱃지: 프로필 이미지 URL (없으면 이름 첫 글자) */
  profileImageUrl?: string;
  /** 이름 (이니셜·대체 텍스트용) */
  name: string;
  gender: "M" | "F";
  grade: Grade;
  /** 크기: md(나의 프로필), sm(표·목록), xs(명단 등 더 작게) */
  size?: "md" | "sm" | "xs";
  className?: string;
}

/** 기준 비율: 메인 원 48px. sm은 동일 비율로 scale만 적용 */
const BASE_SIZE = 48; // px

/** 성별 기호: 이모지 스타일 천문 기호 (♀️ Venus, ♂️ Mars) */
const GENDER_SYMBOL = { F: "\u2640\uFE0F", M: "\u2642\uFE0F" } as const;

/** 급수 기호: 네거티브 스퀘어(네모에 알파벳) 🅰🅱🅲🅳 */
const GRADE_EMOJI: Record<Grade, string> = { A: "🅰", B: "🅱", C: "🅲", D: "🅳" };

/** 성별·급수 동일 색상 (남=파랑, 여=분홍) */
const GENDER_COLOR = { M: "#2563eb", F: "#ec4899" } as const;

/** 아바타 뱃지: 프로필 원 + 성별·급수 기호(12시 방향). 경기 이사 나의 프로필 등에서 사용 */
export function ProfileBadge({ profileImageUrl, name, gender, grade, size = "md", className }: ProfileBadgeProps) {
  const [imgFailed, setImgFailed] = useState(false);
  const isSm = size === "sm";
  const isXs = size === "xs";
  const symbolLabel = `${GENDER_SYMBOL[gender]}${GRADE_EMOJI[grade]}`;

  const inner = (
    <>
      <span className="relative flex-shrink-0 w-12 h-12 rounded-full overflow-hidden bg-slate-200 shadow flex items-center justify-center box-border">
        {profileImageUrl && !imgFailed ? (
          <img
            src={profileImageUrl}
            alt=""
            className="absolute inset-0 w-full h-full object-cover"
            referrerPolicy="no-referrer"
            onError={() => setImgFailed(true)}
          />
        ) : (
          <span className="w-full h-full flex items-center justify-center text-slate-500 font-medium text-xl" aria-hidden>
            {name?.charAt(0)?.toUpperCase() || "?"}
          </span>
        )}
      </span>
      {/* 아바타 뱃지 기호: 12시 방향, 성별·급수 동일 색상·크기 */}
      <span
        className="absolute top-0 left-1/2 -translate-x-1/2 -translate-y-1/2 min-w-[2rem] px-1.5 py-0.5 flex items-center justify-center gap-0 font-black leading-none text-lg tracking-tighter"
        style={{ color: GENDER_COLOR[gender], WebkitTextStroke: "0.4px currentColor", letterSpacing: "-0.08em" }}
        aria-hidden
      >
        <span className="inline-block">{GENDER_SYMBOL[gender]}</span>
        <span className="inline-block align-middle leading-none" style={{ transform: "scale(1.3)", color: "inherit" }}>{GRADE_EMOJI[grade]}</span>
      </span>
    </>
  );

  if (isXs) {
    return (
      <span className={`relative flex-shrink-0 inline-block w-[18px] h-[18px] overflow-visible ${className ?? ""}`}>
        <span
          className="relative block overflow-visible"
          style={{ width: BASE_SIZE, height: BASE_SIZE, transform: "scale(0.375)", transformOrigin: "top left" }}
        >
          {inner}
        </span>
      </span>
    );
  }
  if (isSm) {
    return (
      <span className={`relative flex-shrink-0 inline-block w-6 h-6 overflow-visible ${className ?? ""}`}>
        <span
          className="relative block overflow-visible"
          style={{ width: BASE_SIZE, height: BASE_SIZE, transform: "scale(0.5)", transformOrigin: "top left" }}
        >
          {inner}
        </span>
      </span>
    );
  }

  return (
    <span className={`relative flex-shrink-0 inline-flex w-12 h-12 overflow-visible ${className ?? ""}`}>
      {inner}
    </span>
  );
}
