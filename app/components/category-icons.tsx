"use client";

/** 경기 방식 카테고리용 아이콘 (Lucide 스타일, currentColor 상속) */
const defaultSize = 18;
const stroke = 2;

type IconProps = { size?: number | "responsive"; className?: string };

function svgProps(size: number | "responsive" | undefined, className?: string) {
  if (size === "responsive") return { width: "100%" as const, height: "100%" as const, className };
  const s = size ?? defaultSize;
  return { width: s, height: s, className };
}

export function IconCategoryUser({ size = defaultSize, className }: IconProps) {
  const props = svgProps(size, className);
  return (
    <svg {...props} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="8" r="4" />
      <path d="M20 21a8 8 0 0 0-16 0" />
    </svg>
  );
}

export function IconCategoryUsers({ size = defaultSize, className }: IconProps) {
  const props = svgProps(size, className);
  return (
    <svg {...props} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}

export function IconCategoryUsersRound({ size = defaultSize, className }: IconProps) {
  const props = svgProps(size, className);
  return (
    <svg {...props} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="10" cy="8" r="5" />
      <path d="M2 21a8 8 0 0 1 16 0" />
      <path d="M19 17a5 5 0 0 0-5-5" />
      <path d="M19 13a9 9 0 0 0-9-9" />
    </svg>
  );
}

export function IconCategorySword({ size = defaultSize, className }: IconProps) {
  const props = svgProps(size, className);
  return (
    <svg {...props} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M14.5 17.5 3 6V3h3l11.5 11.5" />
      <path d="m13 6 6-3 3 3-3 6-3-3" />
      <path d="M9.5 17.5 21 9v3l-5 5" />
    </svg>
  );
}
