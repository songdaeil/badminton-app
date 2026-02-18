"use client";

/** 하단 네비게이션용 아이콘 (Lucide 스타일, currentColor 상속) */
const size = 40;
const stroke = 2;

type IconProps = { size?: number; className?: string };
type MyInfoIconProps = IconProps & { filled?: boolean };

/** 경기 방식 - 설정/슬라이더 */
export function NavIconGameMode({ size: s = size, className }: IconProps) {
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <path d="M4 21v-7" />
      <path d="M4 10V3" />
      <path d="M12 21v-9" />
      <path d="M12 8V3" />
      <path d="M20 21v-5" />
      <path d="M20 12V3" />
      <path d="M2 14h6" />
      <path d="M10 8h6" />
      <path d="M18 16h6" />
    </svg>
  );
}

/** 경기 목록 - 목록 */
export function NavIconGameList({ size: s = size, className }: IconProps) {
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <path d="M8 6h13" />
      <path d="M8 12h13" />
      <path d="M8 18h13" />
      <path d="M3 6h.01" />
      <path d="M3 12h.01" />
      <path d="M3 18h.01" />
    </svg>
  );
}

/** 경기 이사 - 나의 정보/사용자 (filled: 프로필 완성 시 검정 채움) */
export function NavIconMyInfo({ size: s = size, className, filled }: MyInfoIconProps) {
  if (filled) {
    return (
      <svg width={s} height={s} viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
        <circle cx="12" cy="8" r="4" />
        <path d="M20 21a8 8 0 0 0-16 0" />
      </svg>
    );
  }
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <circle cx="12" cy="8" r="4" />
      <path d="M20 21a8 8 0 0 0-16 0" />
    </svg>
  );
}
