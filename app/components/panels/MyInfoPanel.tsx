"use client";

import type { Grade } from "@/app/types";
import { useGameView } from "@/app/contexts/GameViewContext";

export function MyInfoPanel() {
  const {
    myInfo,
    setMyInfo,
    saveMyInfo,
    profileEditOpen,
    setProfileEditOpen,
    profileEditClosing,
    setProfileEditClosing,
    setLoginGatePassed,
    signOutPhone,
    signOutEmail,
    getCurrentPhoneUser,
    getCurrentEmailUser,
    isPhoneAuthAvailable,
    isEmailAuthAvailable,
    LOGIN_GATE_KEY,
    uploadProfileToFirestore,
    loginMessage,
  } = useGameView();

  return (
    <div key="myinfo" className="pt-4 space-y-2 animate-fade-in-up">
      {(isPhoneAuthAvailable() && getCurrentPhoneUser()) || (isEmailAuthAvailable() && getCurrentEmailUser()) ? (
        <div className="rounded-2xl bg-white shadow-[0_1px_3px_rgba(0,0,0,0.06)] border border-[#e8e8ed] overflow-hidden">
          <div className="px-3 py-3 space-y-3">
            <p className="text-xs text-slate-500">
              로그인 수단:{" "}
              {[
                isPhoneAuthAvailable() && getCurrentPhoneUser() &&
                  `전화번호 (${getCurrentPhoneUser()?.phoneNumber || ""})`,
                isEmailAuthAvailable() && getCurrentEmailUser() &&
                  `이메일 (${getCurrentEmailUser()?.email || ""})`,
              ]
                .filter(Boolean)
                .join(", ")}
            </p>
            <button
              type="button"
              onClick={async () => {
                if (isPhoneAuthAvailable() && getCurrentPhoneUser()) await signOutPhone();
                if (isEmailAuthAvailable() && getCurrentEmailUser()) await signOutEmail();
                setMyInfo((prev) => {
                  const next = { ...prev, phoneNumber: undefined, email: undefined, uid: undefined };
                  saveMyInfo(next);
                  return next;
                });
                if (typeof window !== "undefined") {
                  sessionStorage.removeItem(LOGIN_GATE_KEY);
                  setLoginGatePassed(false);
                }
              }}
              className="w-full px-4 py-2 rounded-lg text-sm font-medium bg-slate-100 text-slate-700 hover:bg-slate-200 transition-colors btn-tap"
            >
              로그아웃
            </button>
          </div>
        </div>
      ) : null}

      {(getCurrentPhoneUser() || getCurrentEmailUser()) && (
        <div className="rounded-2xl bg-white shadow-[0_1px_3px_rgba(0,0,0,0.06)] border border-[#e8e8ed] overflow-hidden">
          <div className="px-2.5 py-2 border-b border-[#e8e8ed]">
            <h3 className="text-sm font-semibold text-slate-800">나의 프로필</h3>
          </div>
          <div className="px-2.5 py-2 space-y-2">
            <div className="flex items-center gap-2 p-1.5 rounded-xl bg-slate-50 border border-slate-100">
              <p className="min-w-0 flex-1 text-sm font-medium text-slate-800 truncate">
                <span className="tracking-tighter inline-flex items-center gap-0" style={{ letterSpacing: "-0.02em" }}>
                  {myInfo.name || "이름 없음"}
                  <span className="shrink-0 inline-block w-[0.65em] overflow-visible align-middle" style={{ lineHeight: 0 }} title={myInfo.uid ? "Firebase 계정 연동 · 공동편집·통계 연동 가능" : "비연동"} aria-label={myInfo.uid ? "연동" : "비연동"}>
                    <span className="inline-block origin-left" style={{ transform: "scale(0.65)", transformOrigin: "left center", filter: "grayscale(1) brightness(0.9) contrast(1.1)" }}>{myInfo.uid ? "🔃" : "⏸️"}</span>
                  </span>
                  <span className="inline-flex items-center gap-0 text-base leading-none origin-left" style={{ letterSpacing: "-0.08em", color: myInfo.gender === "F" ? "#e8a4bc" : "#7c9fd8", transform: "scale(0.5)", transformOrigin: "left center" }}>
                    <span className="inline-block">{myInfo.gender === "F" ? "\u2640\uFE0F" : "\u2642\uFE0F"}</span>
                    <span className="inline-block leading-none align-middle text-black">{myInfo.grade ?? "D"}</span>
                  </span>
                </span>
              </p>
              <button
                type="button"
                onClick={() => setProfileEditOpen(true)}
                className="shrink-0 px-2.5 py-1 rounded-lg text-xs font-medium bg-[#0071e3] text-white hover:bg-[#0077ed] transition-colors btn-tap"
              >
                프로필 수정
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="rounded-2xl bg-white shadow-[0_1px_3px_rgba(0,0,0,0.06)] border border-[#e8e8ed] overflow-hidden">
        <div className="px-2 py-2 space-y-4">
          <div>
            <h3 className="text-sm font-semibold text-slate-700 mb-1.5">나의 전적</h3>
            <hr className="border-t border-slate-200 my-2" aria-hidden />
            <p className="text-slate-500 text-xs py-2">시스템을 준비중입니다.</p>
          </div>
        </div>
      </div>

      {(profileEditOpen || profileEditClosing) && (
        <div
          className="fixed inset-0 z-30 bg-[var(--background)] flex flex-col max-w-md mx-auto left-0 right-0 min-h-dvh"
          style={{
            animation: profileEditClosing
              ? "slideOutToLeftOverlay 0.25s cubic-bezier(0.32, 0.72, 0, 1) forwards"
              : "slideInFromLeftOverlay 0.3s cubic-bezier(0.32, 0.72, 0, 1) forwards",
          }}
          aria-modal="true"
          onTouchStart={(e) => e.stopPropagation()}
        >
          <header className="flex items-center gap-2 shrink-0 px-3 py-2.5 border-b border-[#e8e8ed] bg-white">
            <button
              type="button"
              onClick={() => {
                if (profileEditClosing) return;
                setProfileEditClosing(true);
                setTimeout(() => {
                  setProfileEditOpen(false);
                  setProfileEditClosing(false);
                }, 250);
              }}
              disabled={profileEditClosing}
              className="flex items-center gap-1 px-2 py-1.5 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-100 transition-colors btn-tap disabled:opacity-70 disabled:pointer-events-none"
              aria-label="뒤로가기"
            >
              <span aria-hidden>←</span>
              <span>뒤로가기</span>
            </button>
            <h2 className="text-sm font-semibold text-slate-800 flex-1 text-center pr-12">프로필 수정</h2>
          </header>
          <div className="flex-1 min-h-0 overflow-y-auto scrollbar-hide-y px-2.5 py-3 space-y-2" data-scrollbar-hide style={{ scrollbarWidth: "none", msOverflowStyle: "none" }}>
            <div className="grid gap-1.5">
              <div className="flex items-center gap-1.5">
                <label className="text-xs font-medium text-slate-600 shrink-0 w-28">이름</label>
                <input
                  type="text"
                  value={myInfo.name}
                  onChange={(e) => {
                    const next = { ...myInfo, name: e.target.value };
                    setMyInfo(next);
                    saveMyInfo(next);
                  }}
                  placeholder="이름"
                  className="flex-1 min-w-0 px-2 py-1.5 rounded-lg border border-[#d2d2d7] bg-[#fbfbfd] text-[#1d1d1f] text-sm focus:outline-none focus:ring-2 focus:ring-[#0071e3]/25 focus:border-[#0071e3]"
                  aria-label="이름"
                />
              </div>
              <div className="flex items-center gap-1.5">
                <label className="text-xs font-medium text-slate-600 shrink-0 w-28">성별</label>
                <select
                  value={myInfo.gender}
                  onChange={(e) => {
                    const next = { ...myInfo, gender: e.target.value as "M" | "F" };
                    setMyInfo(next);
                    saveMyInfo(next);
                  }}
                  className="flex-1 min-w-0 px-2 py-1.5 rounded-lg border border-[#d2d2d7] bg-[#fbfbfd] text-sm focus:outline-none focus:ring-2 focus:ring-[#0071e3]/25"
                  aria-label="성별"
                >
                  <option value="M">남</option>
                  <option value="F">여</option>
                </select>
              </div>
              <div className="flex items-center gap-1.5">
                <label className="text-xs font-medium text-slate-600 shrink-0 w-28">급수</label>
                <select
                  value={myInfo.grade ?? "D"}
                  onChange={(e) => {
                    const next = { ...myInfo, grade: e.target.value as Grade };
                    setMyInfo(next);
                    saveMyInfo(next);
                  }}
                  className="flex-1 min-w-0 px-2 py-1.5 rounded-lg border border-[#d2d2d7] bg-[#fbfbfd] text-sm focus:outline-none focus:ring-2 focus:ring-[#0071e3]/25"
                  aria-label="급수"
                >
                  <option value="A">A</option>
                  <option value="B">B</option>
                  <option value="C">C</option>
                  <option value="D">D</option>
                </select>
              </div>
              <div className="flex items-center gap-1.5">
                <label className="text-xs font-medium text-slate-600 shrink-0 w-28">전화번호</label>
                <input
                  type="tel"
                  value={myInfo.phoneNumber ?? ""}
                  onChange={(e) => {
                    const next = { ...myInfo, phoneNumber: e.target.value.trim() || undefined };
                    setMyInfo(next);
                    saveMyInfo(next);
                  }}
                  placeholder="010-1234-5678"
                  className="flex-1 min-w-0 px-2 py-1.5 rounded-lg border border-[#d2d2d7] bg-[#fbfbfd] text-[#1d1d1f] text-sm focus:outline-none focus:ring-2 focus:ring-[#0071e3]/25 focus:border-[#0071e3]"
                  aria-label="전화번호"
                />
              </div>
              <div className="flex items-center gap-1.5">
                <label className="text-xs font-medium text-slate-600 shrink-0 w-28">생년월일</label>
                <input
                  type="date"
                  value={myInfo.birthDate ?? ""}
                  onChange={(e) => {
                    const next = { ...myInfo, birthDate: e.target.value || undefined };
                    setMyInfo(next);
                    saveMyInfo(next);
                  }}
                  className="flex-1 min-w-0 px-2 py-1.5 rounded-lg border border-[#d2d2d7] bg-[#fbfbfd] text-[#1d1d1f] text-sm focus:outline-none focus:ring-2 focus:ring-[#0071e3]/25 focus:border-[#0071e3]"
                  aria-label="생년월일"
                />
              </div>
              <div className="flex items-center gap-1.5 mt-2">
                <span className="shrink-0 w-28" />
                <button
                  type="button"
                  onClick={uploadProfileToFirestore}
                  className="shrink-0 px-3 py-1.5 rounded-lg text-sm font-medium bg-[#0071e3] text-white hover:bg-[#0077ed] transition-colors btn-tap whitespace-nowrap"
                >
                  업로드
                </button>
                <span className="text-xs text-slate-500">다른 기기에서 로그인 시 이 프로필이 적용됩니다.</span>
              </div>
              {loginMessage && (
                <p className="text-xs text-slate-600 mt-1 px-1">{loginMessage}</p>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
