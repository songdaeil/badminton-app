"use client";

import { useState } from "react";

type Grade = "A" | "B" | "C" | "D";

export interface ProfileBadgeProps {
  /** 프로필 이미지 URL (없으면 이름 첫 글자) */
  profileImageUrl?: string;
  /** 이름 (이니셜·대체 텍스트용) */
  name: string;
  gender: "M" | "F";
  grade: Grade;
  /** 크기: md(나의 프로필과 동일), sm(표·목록용) */
  size?: "md" | "sm";
  className?: string;
}

/** 기준 비율: 메인 원 48px, 급수·성별 뱃지 16px(원 직경의 1/3). sm은 동일 비율로 scale만 적용 */
const BASE_SIZE = 48; // px
const BADGE_SIZE = 16; // 원 대비 1/3

/** 경기 이사 '나의 프로필'과 동일한 조합: 프로필 사진(또는 이니셜) + 급수 뱃지 + 성별 뱃지. 비율 고정. */
export function ProfileBadge({ profileImageUrl, name, gender, grade, size = "md", className }: ProfileBadgeProps) {
  const [imgFailed, setImgFailed] = useState(false);
  const isSm = size === "sm";

  const inner = (
    <>
      <span className="relative w-12 h-12 rounded-full overflow-hidden bg-slate-200 ring-2 ring-white shadow flex items-center justify-center box-border border-2 border-dashed border-amber-400">
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
      {/* 성별 뱃지 중심: 프로필 원 둘레 위 (우하단 45°, 반지름 24 기준 정확 좌표) */}
      <span
        className={`absolute w-4 h-4 -translate-x-1/2 -translate-y-1/2 rounded-full flex items-center justify-center text-white text-xs font-semibold leading-none shadow ${gender === "F" ? "bg-red-500" : "bg-[#0071e3]"}`}
        style={{ left: "40.97px", top: "40.97px" }}
        aria-hidden
      >
        {gender === "F" ? "♀" : "♂"}
      </span>
      {/* 급수 뱃지 중심: 프로필 원 둘레 위 (좌하단 방향, 135°) */}
      <span
        className="absolute left-[7px] top-[41px] min-w-[1rem] h-4 -translate-x-1/2 -translate-y-1/2 px-1 rounded-full bg-slate-600 flex items-center justify-center text-white text-xs font-semibold leading-none shadow"
        aria-hidden
      >
        {grade}
      </span>
    </>
  );

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
