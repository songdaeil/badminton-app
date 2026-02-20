"use client";

import type { NavView } from "@/app/constants";

interface GameViewHeaderProps {
  navView: NavView;
  onGameModeHelp: () => void;
  onRecordHelp: () => void;
}

export function GameViewHeader({ navView, onGameModeHelp, onRecordHelp }: GameViewHeaderProps) {
  return (
    <header className="sticky top-0 z-20 bg-white/80 backdrop-blur-xl border-b border-[#e8e8ed] safe-area-pb">
      <div className="flex items-center gap-3 px-3 py-4">
        <h1 className="text-[1.25rem] font-semibold tracking-tight text-[#1d1d1f] flex items-center gap-1.5">
          {navView === "setting" && (
            <>
              경기 방식
              <button
                type="button"
                onClick={onGameModeHelp}
                className="w-6 h-6 flex items-center justify-center rounded-full bg-slate-200 text-slate-600 hover:bg-slate-300 text-xs font-medium transition-colors"
                aria-label="도움말"
              >
                ?
              </button>
            </>
          )}
          {navView === "record" && (
            <>
              경기 목록
              <button
                type="button"
                onClick={onRecordHelp}
                className="w-6 h-6 flex items-center justify-center rounded-full bg-slate-200 text-slate-600 hover:bg-slate-300 text-xs font-medium transition-colors"
                aria-label="도움말"
              >
                ?
              </button>
            </>
          )}
          {navView === "myinfo" && "경기 이사"}
        </h1>
      </div>
    </header>
  );
}
