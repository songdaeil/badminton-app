"use client";

import type { NavView } from "@/app/constants";
import { NavIconGameList, NavIconGameMode, NavIconMyInfo } from "./nav-icons";

interface AppNavProps {
  navView: NavView;
  isProfileComplete: boolean;
  onNav: (view: NavView) => void;
  onSettingClick: () => void;
  onRecordClick: () => void;
  setShareToast: (msg: string | null) => void;
}

export function AppNav({
  navView,
  isProfileComplete,
  onNav,
  onSettingClick,
  onRecordClick,
  setShareToast,
}: AppNavProps) {
  const handleSetting = () => {
    if (!isProfileComplete) {
      onNav("myinfo");
      setShareToast("프로필을 입력한 뒤 업로드하면 이용할 수 있습니다.");
      setTimeout(() => setShareToast(null), 3000);
      return;
    }
    onNav("setting");
  };

  const handleRecord = () => {
    if (!isProfileComplete) {
      onNav("myinfo");
      setShareToast("프로필을 입력한 뒤 업로드하면 이용할 수 있습니다.");
      setTimeout(() => setShareToast(null), 3000);
      return;
    }
    onNav("record");
    onRecordClick();
  };

  return (
    <nav className="fixed bottom-0 left-0 right-0 max-w-md mx-auto bg-white/90 backdrop-blur-xl border-t border-[#e8e8ed] flex justify-start gap-0 px-2 py-2 shadow-[0_-1px_0_0_rgba(0,0,0,0.06)]">
      <button
        type="button"
        onClick={handleSetting}
        className={`flex flex-col items-center gap-0.5 py-2 px-4 min-w-0 rounded-xl nav-tab btn-tap ${!isProfileComplete ? "opacity-60 text-[#9ca3af]" : ""} ${navView === "setting" ? "bg-[#0071e3]/10 text-[#0071e3] font-semibold" : "text-[#6e6e73] hover:text-[#1d1d1f] hover:bg-black/5"}`}
      >
        <NavIconGameMode className="w-10 h-10 shrink-0" />
        <span className="text-sm font-medium leading-tight">경기 방식</span>
      </button>
      <button
        type="button"
        onClick={handleRecord}
        className={`flex flex-col items-center gap-0.5 py-2 px-4 min-w-0 rounded-xl nav-tab btn-tap ${!isProfileComplete ? "opacity-60 text-[#9ca3af]" : ""} ${navView === "record" ? "bg-[#0071e3]/10 text-[#0071e3] font-semibold" : "text-[#6e6e73] hover:text-[#1d1d1f] hover:bg-black/5"}`}
      >
        <NavIconGameList className="w-10 h-10 shrink-0" />
        <span className="text-sm font-medium leading-tight">경기 목록</span>
      </button>
      <button
        type="button"
        onClick={() => onNav("myinfo")}
        className={`relative flex flex-col items-center gap-0.5 py-2 px-4 min-w-0 rounded-xl nav-tab btn-tap ${navView === "myinfo" ? "bg-[#0071e3]/10 text-[#0071e3] font-semibold" : "text-[#6e6e73] hover:text-[#1d1d1f] hover:bg-black/5"}`}
      >
        <NavIconMyInfo className="w-10 h-10 shrink-0" filled={isProfileComplete} />
        <span className="text-sm font-medium leading-tight">경기 이사</span>
      </button>
    </nav>
  );
}
