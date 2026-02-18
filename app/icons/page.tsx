"use client";

/**
 * 무료 아이콘 미리보기 — 복식/단식/대항전/단체 대표 후보
 * (Lucide 스타일 stroke SVG, 24×24)
 */
const size = 48;
const stroke = 2;

function IconUser() {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="8" r="4" />
      <path d="M20 21a8 8 0 0 0-16 0" />
    </svg>
  );
}

function IconUsers() {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round">
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}

function IconUsersRound() {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="10" cy="8" r="5" />
      <path d="M2 21a8 8 0 0 1 16 0" />
      <path d="M19 17a5 5 0 0 0-5-5" />
      <path d="M19 13a9 9 0 0 0-9-9" />
    </svg>
  );
}

function IconSword() {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round">
      <path d="M14.5 17.5 3 6V3h3l11.5 11.5" />
      <path d="m13 6 6-3 3 3-3 6-3-3" />
      <path d="M9.5 17.5 21 9v3l-5 5" />
    </svg>
  );
}

function IconTrophy() {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6" />
      <path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18" />
      <path d="M4 22h16" />
      <path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20 7 22" />
      <path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20 17 22" />
      <path d="M18 2H6v7a6 6 0 0 0 12 0V2Z" />
    </svg>
  );
}

function IconShield() {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10" />
    </svg>
  );
}

const CATEGORIES = [
  { id: "singles", label: "단식", icons: [{ name: "User (1인)", Icon: IconUser }] },
  { id: "doubles", label: "복식", icons: [{ name: "Users (2인)", Icon: IconUsers }] },
  { id: "contest", label: "대항전", icons: [{ name: "Sword (대결)", Icon: IconSword }, { name: "Trophy (대회)", Icon: IconTrophy }, { name: "Shield (대항)", Icon: IconShield }] },
  { id: "team", label: "단체", icons: [{ name: "UsersRound (그룹)", Icon: IconUsersRound }, { name: "Users (복식과 동일)", Icon: IconUsers }] },
] as const;

export default function IconsPage() {
  return (
    <main className="min-h-screen bg-slate-50 p-6 max-w-lg mx-auto">
      <h1 className="text-xl font-bold text-slate-800 mb-1">무료 아이콘 미리보기</h1>
      <p className="text-sm text-slate-600 mb-6">복식 · 단식 · 대항전 · 단체 대표 후보 (Lucide 스타일)</p>
      <div className="space-y-8">
        {CATEGORIES.map((cat) => (
          <section key={cat.id} className="bg-white rounded-xl border border-slate-200 p-4 shadow-sm">
            <h2 className="text-base font-semibold text-slate-800 mb-4">{cat.label}</h2>
            <div className="flex flex-wrap gap-6">
              {cat.icons.map(({ name, Icon }) => (
                <div key={name} className="flex flex-col items-center gap-2">
                  <div className="text-slate-700">
                    <Icon />
                  </div>
                  <span className="text-xs text-slate-500 text-center">{name}</span>
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
      <p className="text-xs text-slate-400 mt-8 text-center">
        실제 앱에 적용 시 <code className="bg-slate-200 px-1 rounded">lucide-react</code> 패키지로 동일 아이콘 사용 가능
      </p>
    </main>
  );
}
