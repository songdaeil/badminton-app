"use client";

import { useGameView } from "@/app/contexts/GameViewContext";

export function SettingPanel() {
  const {
    GAME_CATEGORIES,
    GAME_MODES,
    gameModeCategoryId,
    setGameModeCategoryId,
    gameModeId,
    setGameModeId,
    gameSettings,
    setGameSettings,
    gameMode,
    addGameToRecord,
    getTargetTotalGames,
    getMaxCourts,
    MINUTES_PER_21PT_GAME,
    formatEstimatedDuration,
  } = useGameView();

  return (
    <div key="setting" className="space-y-2 pt-4 animate-fade-in-up">
      <section id="section-info" className="scroll-mt-2">
        <div className="rounded-2xl bg-white shadow-[0_1px_3px_rgba(0,0,0,0.06)] border border-[#e8e8ed] overflow-hidden min-w-0">
          <div className="flex border-b border-[#e8e8ed] flex-nowrap min-w-0">
            {GAME_CATEGORIES.map((cat) => {
              const modesInCat = GAME_MODES.filter((m) => (m.categoryId ?? GAME_CATEGORIES[0].id) === cat.id);
              const isActive = gameModeCategoryId === cat.id;
              return (
                <button
                  key={cat.id}
                  type="button"
                  onClick={() => {
                    setGameModeCategoryId(cat.id);
                    const firstInCat = modesInCat[0];
                    if (firstInCat && !modesInCat.some((m) => m.id === gameModeId)) {
                      setGameModeId(firstInCat.id);
                      const defaultScore = firstInCat.defaultScoreLimit ?? 21;
                      setGameSettings((prev) => ({ ...prev, scoreLimit: prev.scoreLimit >= 1 && prev.scoreLimit <= 99 ? prev.scoreLimit : defaultScore }));
                    }
                  }}
                  className={`flex-1 min-w-0 px-1.5 py-2 sm:px-2.5 sm:py-2 text-[clamp(0.8125rem,2.2vw,1.125rem)] font-medium border-b-2 transition-colors flex items-center justify-center gap-1 sm:gap-2 ${isActive ? "border-[#0071e3] text-[#0071e3]" : "border-transparent text-slate-600 hover:text-slate-800"}`}
                >
                  {cat.Icon && (
                    <span className="shrink-0 w-[clamp(1.25rem,6vw,2rem)] h-[clamp(1.25rem,6vw,2rem)] flex items-center justify-center">
                      <cat.Icon size="responsive" className="w-full h-full" />
                    </span>
                  )}
                  <span className="truncate">{cat.label}</span>
                </button>
              );
            })}
          </div>
          <div className="flex flex-row min-h-0 min-w-[280px]">
            <nav className="min-w-[3.75rem] w-[3.75rem] shrink-0 border-r border-[#e8e8ed] bg-slate-50/50">
              <ul className="py-0">
                {GAME_MODES.filter((m) => (m.categoryId ?? GAME_CATEGORIES[0].id) === gameModeCategoryId).map((mode) => {
                  const isSelected = gameModeId === mode.id;
                  return (
                    <li key={mode.id}>
                      <button
                        type="button"
                        onClick={() => {
                          setGameModeId(mode.id);
                          const defaultScore = mode.defaultScoreLimit ?? 21;
                          setGameSettings((prev) => ({ ...prev, scoreLimit: prev.scoreLimit >= 1 && prev.scoreLimit <= 99 ? prev.scoreLimit : defaultScore }));
                        }}
                        className={`w-full text-left px-0 py-0 min-h-[1.5rem] text-sm rounded-r border-l-2 transition-colors whitespace-nowrap ${isSelected ? "border-[#0071e3] bg-[#0071e3]/10 text-[#0071e3] font-medium" : "border-transparent text-slate-700 hover:bg-slate-100/80"}`}
                      >
                        {mode.label}
                      </button>
                    </li>
                  );
                })}
              </ul>
              {GAME_MODES.filter((m) => (m.categoryId ?? GAME_CATEGORIES[0].id) === gameModeCategoryId).length === 0 && (
                <p className="px-0.5 py-2 text-xs text-slate-500">이 카테고리에 등록된 경기 방식이 없습니다.</p>
              )}
            </nav>
            <div className="flex-1 min-w-0 px-1 py-1 text-fluid-base text-[#6e6e73] space-y-1 leading-relaxed">
              {(gameMode.categoryId ?? GAME_CATEGORIES[0].id) === gameModeCategoryId ? (
                <>
                  <button
                    type="button"
                    onClick={addGameToRecord}
                    disabled={gameModeId === "individual_b"}
                    className="w-full py-1.5 rounded-xl font-semibold text-white bg-[#0071e3] hover:bg-[#0077ed] transition-colors mb-3 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-[#0071e3] btn-tap"
                  >
                    아래 경기 방식으로 경기 목록에 추가
                  </button>
                  {gameModeId === "individual_b" && (
                    <p className="text-xs text-slate-500 mb-2">개인전b는 아직 경기 목록 추가 기능을 지원하지 않습니다.</p>
                  )}
                  {gameModeId === "individual" ? (
                    <div className="space-y-3">
                      <div>
                        <p className="text-sm font-semibold text-[#0071e3] mb-0.5 leading-tight">특징</p>
                        <div className="space-y-0.5 text-slate-600 text-sm leading-tight">
                          <p>인원에 따라 총 경기 수와 인당 경기 수가 아래 표처럼 정해져 있으며, 참가자는 모두 동일한 경기 수로 공정하게 진행합니다.</p>
                          <p>파트너와 상대를 경기마다 바꿔 가며 여러 분과 골고루 대전할 수 있습니다.</p>
                        </div>
                      </div>
                      <div>
                        <p className="text-sm font-semibold text-[#0071e3] mb-0.5 leading-tight">인원</p>
                        <p className="text-slate-600 text-sm leading-tight">{gameMode.minPlayers}~{gameMode.maxPlayers}명</p>
                      </div>
                      <div>
                        <p className="text-sm font-semibold text-[#0071e3] mb-0.5 leading-tight">경기수·소요시간</p>
                        <div className="overflow-x-auto mt-0.5 min-w-0">
                          <table className="w-full min-w-[240px] table-auto border-collapse text-xs text-slate-600 leading-tight font-numeric">
                            <colgroup>
                              <col className="min-w-0" />
                              <col className="min-w-0" />
                              <col className="min-w-0" />
                              <col className="min-w-0" />
                              <col style={{ minWidth: "4.5rem" }} />
                            </colgroup>
                            <thead>
                              <tr className="bg-slate-100">
                                <th className="border border-slate-200 px-2 py-0 text-center font-semibold text-slate-700 whitespace-nowrap">인원</th>
                                <th className="border border-slate-200 px-2 py-0 text-center font-semibold text-slate-700 whitespace-nowrap">총</th>
                                <th className="border border-slate-200 px-2 py-0 text-center font-semibold text-slate-700 whitespace-nowrap">인당</th>
                                <th className="border border-slate-200 px-2 py-0 text-center font-semibold text-slate-700 whitespace-nowrap">코트</th>
                                <th className="border border-slate-200 px-2 py-0 text-center font-semibold text-slate-700 whitespace-nowrap">소요</th>
                              </tr>
                            </thead>
                            <tbody>
                              {Array.from({ length: gameMode.maxPlayers - gameMode.minPlayers + 1 }, (_, i) => gameMode.minPlayers + i).map((n) => {
                                const total = getTargetTotalGames(n);
                                const perPerson = total > 0 && n > 0 ? Math.round((total * 4) / n) : 0;
                                const maxCourts = getMaxCourts(n);
                                const totalMinutesRaw = total * MINUTES_PER_21PT_GAME;
                                const minutesForMaxCourts = Math.ceil(totalMinutesRaw / maxCourts);
                                const durationLabel = formatEstimatedDuration(minutesForMaxCourts);
                                const courtLabel = maxCourts;
                                return (
                                  <tr key={n} className="even:bg-slate-50">
                                    <td className="border border-slate-200 px-2 py-0 text-center whitespace-nowrap">{n}</td>
                                    <td className="border border-slate-200 px-2 py-0 text-center whitespace-nowrap">{total}</td>
                                    <td className="border border-slate-200 px-2 py-0 text-center whitespace-nowrap">{perPerson}</td>
                                    <td className="border border-slate-200 px-2 py-0 text-center text-slate-600 whitespace-nowrap">{courtLabel}</td>
                                    <td className="border border-slate-200 px-2 py-0 text-center text-slate-600 whitespace-nowrap">{durationLabel}</td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    </div>
                  ) : gameModeId === "individual_b" ? (
                    <div className="space-y-3">
                      <div>
                        <p className="text-sm font-semibold text-[#0071e3] mb-0.5 leading-tight">특징</p>
                        <p className="text-slate-600 text-sm leading-tight">개인전b 전용 규칙입니다. (내용 추후 입력)</p>
                      </div>
                      <div>
                        <p className="text-sm font-semibold text-[#0071e3] mb-0.5 leading-tight">인원</p>
                        <p className="text-slate-500 text-sm leading-tight">추후 정의됩니다.</p>
                      </div>
                      <div>
                        <p className="text-sm font-semibold text-[#0071e3] mb-0.5 leading-tight">경기수·소요시간</p>
                        <p className="text-slate-500 text-xs leading-tight">개인전b 전용 표는 추후 정의됩니다.</p>
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      <div>
                        <p className="text-sm font-semibold text-[#0071e3] mb-0.5 leading-tight">인원</p>
                        <p className="text-slate-600 text-sm leading-tight">{gameMode.minPlayers}~{gameMode.maxPlayers}명</p>
                      </div>
                    </div>
                  )}
                </>
              ) : (
                <p className="text-sm text-slate-500 py-8 text-center">왼쪽 목록에서 경기 방식을 선택하면 상세 내용이 표시됩니다.</p>
              )}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
