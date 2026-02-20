"use client";

import { useGameView } from "@/app/contexts/GameViewContext";
import type { Grade } from "@/app/types";
import type { Match } from "@/app/types";

export function RecordPanel() {
  const {
    GAME_MODES,
    loadGame,
    loadGameList,
    getTargetTotalGames,
    listMenuOpenId,
    setListMenuOpenId,
    setSelectedGameId,
    handleDeleteCard,
    handleCopyCard,
    handleShareCard,
    recordDetailClosing,
    effectiveGameId,
    onCloseRecordDetail,
    lastFirestoreUploadBytes,
    gameName,
    setGameName,
    gameSettings,
    setGameSettings,
    gameMode,
    members,
    gameSummaryFocusedRef,
    TIME_OPTIONS_30MIN,
    removeMember,
    newMemberName,
    setNewMemberName,
    newMemberGender,
    setNewMemberGender,
    newMemberGrade,
    setNewMemberGrade,
    addMember,
    addMemberAsMe,
    myInfo,
    getCurrentUserUid,
    rosterChangedSinceGenerate,
    setShowRegenerateConfirm,
    doMatch,
    matches,
    playingMatches,
    playableMatches,
    playingMatchIdsSet,
    playableMatchIdsSet,
    togglePlayingMatch,
    scoreInputs,
    updateScoreInput,
    scoreLimit,
    saveResult,
    formatSavedAt,
    highlightMemberId,
    setHighlightMemberId,
    ranking,
    selectedGameId,
  } = useGameView();

  return (
    <div key="record-wrap" className="relative pt-4 min-h-[70vh]">
      {!selectedGameId && (
        <div key="record-list" className="space-y-0.5 animate-fade-in-up">
          {(() => {
            const gameIds = loadGameList();
            const sortedIds = [...gameIds].sort((a, b) => {
              const tA = loadGame(a).createdAt ?? "";
              const tB = loadGame(b).createdAt ?? "";
              return tB.localeCompare(tA);
            });
            return gameIds.length === 0 ? (
              <p className="text-sm text-slate-500 py-8 text-center">
                아직 추가된 경기이 없습니다.
                <br />
                경기 세팅에서 경기 방식을 선택한 뒤 &apos;목록에 추가&apos;를 누르세요.
              </p>
            ) : (
              <ul className="space-y-0.5">
                {sortedIds.map((id, index) => {
                  const data = loadGame(id);
                  const isNewest = index === 0;
                  const mode = data.gameMode ? GAME_MODES.find((m) => m.id === data.gameMode) : null;
                  const modeLabel = mode?.label ?? data.gameMode ?? "경기";
                  const hasCustomName = typeof data.gameName === "string" && data.gameName.trim();
                  const titleLabel = hasCustomName ? data.gameName!.trim().replace(/_/g, " ") : "";
                  const dateStr = data.createdAt
                    ? (() => {
                        try {
                          const d = new Date(data.createdAt!);
                          return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
                        } catch {
                          return "";
                        }
                      })()
                    : "";
                  const creatorName = data.createdBy ? data.members.find((m) => m.id === data.createdBy)?.name : null;
                  const creatorDisplay = creatorName ?? data.createdByName ?? "알 수 없음";
                  const hasMatches = data.matches.length > 0;
                  const completedCount = data.matches.filter((m) => m.score1 != null && m.score2 != null).length;
                  const matchIdSet = new Set(data.matches.map((m) => String(m.id)));
                  const ongoingCount = (data.playingMatchIds ?? []).filter((id) => matchIdSet.has(id)).length;
                  const allDone = hasMatches && completedCount === data.matches.length;
                  const currentStage =
                    !hasMatches
                      ? "신청단계"
                      : completedCount === 0 && ongoingCount === 0
                        ? "생성단계"
                        : allDone
                          ? "종료단계"
                          : "진행단계";
                  const stages = ["신청단계", "생성단계", "진행단계", "종료단계"] as const;
                  const stageHighlight: Record<(typeof stages)[number], string> = {
                    신청단계: "bg-green-100 text-green-700 border border-green-200",
                    생성단계: "bg-blue-100 text-blue-700 border border-blue-200",
                    진행단계: "bg-amber-100 text-amber-700 border border-amber-200",
                    종료단계: "bg-slate-800 text-white border border-slate-700",
                  };
                  const tableHeaderByStage: Record<(typeof stages)[number], string> = {
                    신청단계: "bg-green-100 text-green-700",
                    생성단계: "bg-blue-100 text-blue-700",
                    진행단계: "bg-amber-100 text-amber-700",
                    종료단계: "bg-slate-800 text-white",
                  };
                  const stageMuted = "bg-slate-50 text-slate-400";
                  const tableHeaderClass = tableHeaderByStage[currentStage];
                  const total = data.matches.length;
                  const waitingCount = total - completedCount - ongoingCount;
                  const pct = (n: number) => (total ? Math.round((n / total) * 100) : 0);
                  const isMenuOpen = listMenuOpenId === id;
                  const staggerClass = [
                    "animate-stagger-1",
                    "animate-stagger-2",
                    "animate-stagger-3",
                    "animate-stagger-4",
                    "animate-stagger-5",
                    "animate-stagger-6",
                    "animate-stagger-7",
                    "animate-stagger-8",
                  ][index % 8];
                  return (
                    <li key={id} className={`relative animate-fade-in-up ${staggerClass}`}>
                      {isNewest && (
                        <span className="absolute left-0 top-0 z-10" style={{ width: 18, height: 18 }}>
                          <span
                            className="absolute left-0 top-0 block"
                            style={{
                              width: 0,
                              height: 0,
                              borderStyle: "solid",
                              borderWidth: "18px 18px 0 0",
                              borderColor: "#f59e0b transparent transparent transparent",
                            }}
                          />
                          <span className="absolute left-[2px] top-0 text-[9px] font-bold text-white leading-none drop-shadow-[0_0_1px_rgba(0,0,0,0.5)]">
                            N
                          </span>
                        </span>
                      )}
                      <button
                        type="button"
                        onClick={() => {
                          setListMenuOpenId(null);
                          setSelectedGameId(id);
                        }}
                        className="w-full text-left px-2.5 py-1.5 pr-8 rounded-lg bg-white border border-[#e8e8ed] shadow-[0_1px_2px_rgba(0,0,0,0.05)] hover:bg-slate-50 transition-colors btn-tap"
                      >
                        <p
                          className="font-semibold text-slate-800 truncate text-sm leading-tight font-numeric min-h-[1.25rem]"
                          title={titleLabel}
                        >
                          {titleLabel || "\u00A0"}
                        </p>
                        <div className="mt-0 space-y-px w-full block">
                          <p className="text-fluid-sm text-slate-500 leading-tight">경기 방식: {modeLabel}</p>
                          <p className="text-fluid-sm text-slate-500 leading-tight font-numeric">
                            경기 인원:{" "}
                            {mode && data.members.length >= mode.minPlayers && data.members.length <= mode.maxPlayers ? (
                              (() => {
                                const targetTotal = getTargetTotalGames(data.members.length);
                                const perPerson = targetTotal > 0 ? Math.round((targetTotal * 4) / data.members.length) : "-";
                                return (
                                  <>
                                    총{data.members.length}명-총{targetTotal}경기-인당{perPerson}경기
                                  </>
                                );
                              })()
                            ) : (
                              <>총{data.members.length}명-총-경기-인당-경기</>
                            )}
                          </p>
                          {(() => {
                            const gs = data.gameSettings;
                            const date = gs?.date?.trim();
                            const time = gs?.time?.trim();
                            const loc = gs?.location?.trim();
                            const score =
                              typeof gs?.scoreLimit === "number" && gs.scoreLimit >= 1 ? gs.scoreLimit : null;
                            const parts: string[] = [];
                            if (date) {
                              try {
                                const [y, m, d] = date.split("-");
                                if (m && d) parts.push(`${parseInt(m, 10)}/${parseInt(d, 10)}`);
                              } catch {
                                parts.push(date);
                              }
                            }
                            if (time) parts.push(time);
                            if (loc) parts.push(loc.length > 8 ? `${loc.slice(0, 8)}…` : loc);
                            if (score) parts.push(`${score}점제`);
                            if (parts.length > 0) {
                              return (
                                <p className="text-fluid-sm text-slate-500 leading-tight">
                                  경기 언제·어디·승점: {parts.join(" · ")}
                                </p>
                              );
                            }
                            return null;
                          })()}
                          <p className="text-fluid-sm text-slate-500 leading-tight">
                            만든 이: {creatorDisplay}
                            {dateStr ? ` ${dateStr}` : ""}
                          </p>
                          <div className="w-full flex flex-col gap-0.5 pt-1">
                            <div className="flex items-center gap-1 flex-wrap">
                              {stages.map((s) => (
                                <span
                                  key={s}
                                  className={`text-xs font-medium px-1.5 py-0 rounded-full shrink-0 leading-none ${s === currentStage ? stageHighlight[s] : stageMuted}`}
                                >
                                  {s.replace("단계", "")}
                                </span>
                              ))}
                            </div>
                            {total > 0 && (
                              <table className="w-full max-w-[200px] text-xs border border-slate-200 rounded overflow-hidden font-numeric table-fixed border-collapse">
                                <tbody>
                                  <tr className={tableHeaderClass}>
                                    <th
                                      className={`py-0 px-1 text-center font-medium leading-none w-1/4 border-r ${currentStage === "종료단계" ? "border-slate-600" : "border-slate-200"}`}
                                    >
                                      총
                                    </th>
                                    <th
                                      className={`py-0 px-1 text-center font-medium leading-none w-1/4 border-r ${currentStage === "종료단계" ? "border-slate-600" : "border-slate-200"}`}
                                    >
                                      종료
                                    </th>
                                    <th
                                      className={`py-0 px-1 text-center font-medium leading-none w-1/4 border-r ${currentStage === "종료단계" ? "border-slate-600" : "border-slate-200"}`}
                                    >
                                      진행
                                    </th>
                                    <th className="py-0 px-1 text-center font-medium leading-none w-1/4">대기</th>
                                  </tr>
                                  <tr className="border-t border-[#e8e8ed] bg-white text-slate-700">
                                    <td className="py-0 px-1 text-center font-medium leading-none border-r border-slate-200">
                                      {total}
                                    </td>
                                    <td className="py-0 px-1 text-center font-medium border-r border-slate-200 leading-none">
                                      {completedCount}
                                    </td>
                                    <td className="py-0 px-1 text-center font-medium border-r border-slate-200 leading-none">
                                      {ongoingCount}
                                    </td>
                                    <td className="py-0 px-1 text-center font-medium leading-none">{waitingCount}</td>
                                  </tr>
                                  <tr className="bg-white text-slate-700">
                                    <td className="py-0 px-1 text-center text-slate-500 font-normal leading-none border-r border-slate-200">
                                      {pct(total)}%
                                    </td>
                                    <td className="py-0 px-1 text-center text-slate-500 font-normal border-r border-slate-200 leading-none">
                                      {pct(completedCount)}%
                                    </td>
                                    <td className="py-0 px-1 text-center text-slate-500 font-normal border-r border-slate-200 leading-none">
                                      {pct(ongoingCount)}%
                                    </td>
                                    <td className="py-0 px-1 text-center text-slate-500 font-normal leading-none">
                                      {pct(waitingCount)}%
                                    </td>
                                  </tr>
                                </tbody>
                              </table>
                            )}
                          </div>
                        </div>
                      </button>
                      <div className="absolute top-1 right-1">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setListMenuOpenId(listMenuOpenId === id ? null : id);
                          }}
                          className="p-1 rounded text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                          aria-label="메뉴"
                          aria-expanded={isMenuOpen}
                        >
                          <span className="text-base leading-none">⋯</span>
                        </button>
                        {isMenuOpen && (
                          <>
                            <div
                              className="fixed inset-0 z-10"
                              aria-hidden
                              onClick={() => setListMenuOpenId(null)}
                            />
                            <div className="absolute right-0 top-full mt-0.5 py-1 min-w-[100px] rounded-lg bg-white border border-slate-200 shadow-lg z-20">
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleDeleteCard(id);
                                }}
                                className="w-full text-left px-2.5 py-1.5 text-xs text-red-600 hover:bg-red-50 rounded-t-lg btn-tap"
                              >
                                삭제
                              </button>
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleCopyCard(id);
                                }}
                                className="w-full text-left px-2.5 py-1.5 text-xs text-slate-700 hover:bg-slate-50 btn-tap"
                              >
                                복사
                              </button>
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleShareCard(id);
                                }}
                                className="w-full text-left px-2.5 py-1.5 text-xs text-slate-700 hover:bg-slate-50 rounded-b-lg btn-tap"
                              >
                                공유
                              </button>
                            </div>
                          </>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            );
          })()}
        </div>
      )}

      {selectedGameId && (
        <div
          key="record-detail"
          className="absolute inset-0 pt-4 bg-[var(--background)] overflow-y-auto"
          style={{
            animation: recordDetailClosing
              ? "slideOutToLeftOverlay 0.25s cubic-bezier(0.32, 0.72, 0, 1) forwards"
              : "slideInFromLeftOverlay 0.3s cubic-bezier(0.32, 0.72, 0, 1) forwards",
          }}
          onTouchStart={(e) => e.stopPropagation()}
        >
          <div className="space-y-4 pb-8">
            <div className="flex items-center justify-between gap-2 pb-2">
              <button
                type="button"
                onClick={onCloseRecordDetail}
                disabled={recordDetailClosing}
                className="text-sm font-medium text-[#0071e3] hover:underline disabled:opacity-70 disabled:pointer-events-none"
              >
                ← 목록으로
              </button>
              {effectiveGameId != null &&
                lastFirestoreUploadBytes != null &&
                loadGame(effectiveGameId).shareId && (
                  <span
                    className="text-xs text-slate-500 font-numeric"
                    title="방금 Firestore에 업로드한 용량"
                  >
                    마지막 업로드:{" "}
                    {lastFirestoreUploadBytes < 1024
                      ? `${lastFirestoreUploadBytes} B`
                      : `${(lastFirestoreUploadBytes / 1024).toFixed(2)} KB`}
                  </span>
                )}
            </div>
            <div className="rounded-2xl bg-white shadow-[0_1px_3px_rgba(0,0,0,0.06)] border border-[#e8e8ed] overflow-hidden mt-2">
              <div className="px-4 py-0.5 border-b border-[#e8e8ed]">
                <h3 className="text-base font-semibold text-slate-800 leading-tight">경기 요약</h3>
              </div>
              <div className="px-4 py-0.5 space-y-px">
                <div className="flex items-center gap-0.5 py-0.5">
                  <label
                    htmlFor="game-name"
                    className="text-xs font-medium text-slate-600 shrink-0 w-16"
                  >
                    경기 이름
                  </label>
                  <input
                    id="game-name"
                    type="text"
                    value={gameName}
                    onChange={(e) => setGameName(e.target.value)}
                    onFocus={() => {
                      gameSummaryFocusedRef.current = true;
                    }}
                    onBlur={() => {
                      gameSummaryFocusedRef.current = false;
                    }}
                    placeholder="경기 이름 입력"
                    className="flex-1 min-w-0 px-2 py-0.5 rounded-lg border border-[#d2d2d7] bg-[#fbfbfd] text-[#1d1d1f] placeholder:text-[#6e6e73] text-sm focus:outline-none focus:ring-2 focus:ring-[#0071e3]/25 focus:border-[#0071e3]"
                    aria-label="경기 이름"
                  />
                </div>
                <div className="flex items-center gap-0.5 py-0.5">
                  <span className="text-xs font-medium text-slate-600 shrink-0 w-16">경기 방식</span>
                  <span
                    className="flex-1 text-sm font-medium text-slate-500 bg-slate-100 px-2 py-0.5 rounded-lg border border-slate-200 cursor-default select-none"
                    title="경기 방식에서 선택한 값 (변경 불가)"
                  >
                    {gameMode.label}
                  </span>
                </div>
                <div className="flex items-center gap-0.5 py-0.5">
                  <span className="text-xs font-medium text-slate-600 shrink-0 w-16">경기 인원</span>
                  <span
                    className="flex-1 text-sm font-medium text-slate-500 font-numeric bg-slate-100 px-2 py-0.5 rounded-lg border border-slate-200 cursor-default select-none inline-block"
                    title="경기 명단 인원 기준 (변경 불가)"
                  >
                    {members.length >= gameMode.minPlayers && members.length <= gameMode.maxPlayers ? (
                      <>
                        총{members.length}명-총{getTargetTotalGames(members.length)}경기-인당
                        {getTargetTotalGames(members.length) > 0
                          ? Math.round((getTargetTotalGames(members.length) * 4) / members.length)
                          : "-"}
                        경기
                      </>
                    ) : (
                      <>총{members.length}명-총-경기-인당-경기</>
                    )}
                  </span>
                </div>
                <div className="flex items-center gap-0.5 py-0.5">
                  <label
                    htmlFor="game-date"
                    className="text-xs font-medium text-slate-600 shrink-0 w-16"
                  >
                    경기 언제
                  </label>
                  <input
                    id="game-date"
                    type="date"
                    value={gameSettings.date}
                    onChange={(e) => setGameSettings((s) => ({ ...s, date: e.target.value }))}
                    onFocus={() => {
                      gameSummaryFocusedRef.current = true;
                    }}
                    onBlur={() => {
                      gameSummaryFocusedRef.current = false;
                    }}
                    className="flex-1 min-w-0 px-2 py-0.5 rounded-lg border border-[#d2d2d7] bg-[#fbfbfd] text-[#1d1d1f] text-sm focus:outline-none focus:ring-2 focus:ring-[#0071e3]/25 focus:border-[#0071e3] focus:border-blue-400"
                    aria-label="날짜"
                  />
                  <select
                    id="game-time"
                    value={TIME_OPTIONS_30MIN.includes(gameSettings.time) ? gameSettings.time : TIME_OPTIONS_30MIN[0]}
                    onChange={(e) => setGameSettings((s) => ({ ...s, time: e.target.value }))}
                    onFocus={() => {
                      gameSummaryFocusedRef.current = true;
                    }}
                    onBlur={() => {
                      gameSummaryFocusedRef.current = false;
                    }}
                    className="w-24 px-2 py-0.5 rounded-lg border border-[#d2d2d7] bg-[#fbfbfd] text-[#1d1d1f] text-sm focus:outline-none focus:ring-2 focus:ring-[#0071e3]/25 focus:border-[#0071e3] focus:border-blue-400"
                    aria-label="시작 시간 (30분 단위)"
                  >
                    {TIME_OPTIONS_30MIN.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="flex items-center gap-0.5 py-0.5">
                  <label
                    htmlFor="game-location"
                    className="text-xs font-medium text-slate-600 shrink-0 w-16"
                  >
                    경기 어디
                  </label>
                  <input
                    id="game-location"
                    type="text"
                    value={gameSettings.location}
                    onChange={(e) => setGameSettings((s) => ({ ...s, location: e.target.value }))}
                    onFocus={() => {
                      gameSummaryFocusedRef.current = true;
                    }}
                    onBlur={() => {
                      gameSummaryFocusedRef.current = false;
                    }}
                    placeholder="장소 입력"
                    className="flex-1 min-w-0 px-2 py-0.5 rounded-lg border border-[#d2d2d7] bg-[#fbfbfd] text-[#1d1d1f] placeholder:text-[#6e6e73] text-sm focus:outline-none focus:ring-2 focus:ring-[#0071e3]/25 focus:border-[#0071e3]"
                    aria-label="장소"
                  />
                </div>
                <div className="flex items-center gap-0.5 py-0.5">
                  <label
                    htmlFor="game-score-limit"
                    className="text-xs font-medium text-slate-600 shrink-0 w-16"
                  >
                    경기 승점
                  </label>
                  <input
                    id="game-score-limit"
                    type="number"
                    min={1}
                    max={99}
                    value={gameSettings.scoreLimit}
                    onChange={(e) => {
                      if (e.target.value === "") {
                        setGameSettings((s) => ({ ...s, scoreLimit: 21 }));
                        return;
                      }
                      const v = parseInt(e.target.value, 10);
                      const num = Number.isNaN(v) ? 21 : Math.max(1, Math.min(99, v));
                      setGameSettings((s) => ({ ...s, scoreLimit: num }));
                    }}
                    onFocus={() => {
                      gameSummaryFocusedRef.current = true;
                    }}
                    onBlur={() => {
                      gameSummaryFocusedRef.current = false;
                    }}
                    placeholder="21"
                    className="flex-1 min-w-0 w-20 px-2 py-0.5 rounded-lg border border-[#d2d2d7] bg-[#fbfbfd] text-[#1d1d1f] text-sm focus:outline-none focus:ring-2 focus:ring-[#0071e3]/25 focus:border-[#0071e3] focus:border-blue-400 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                    aria-label="한 경기당 득점 제한 (직접 입력)"
                  />
                  <span className="text-xs text-slate-500 shrink-0">점</span>
                </div>
              </div>
            </div>

            <div
              id="section-members"
              className="rounded-2xl bg-white shadow-[0_1px_3px_rgba(0,0,0,0.06)] border border-[#e8e8ed] overflow-hidden mt-2 scroll-mt-2"
            >
              <div className="px-2 py-1.5 border-b border-[#e8e8ed] flex items-center justify-between">
                <div>
                  <h3 className="text-base font-semibold text-slate-800">경기 명단</h3>
                  <p className="text-xs text-slate-500 mt-0.5">
                    아래에서 경기 인원을 추가·삭제할 수 있습니다.{" "}
                    <span
                      className="inline-block"
                      style={{ filter: "grayscale(1) brightness(0.9) contrast(1.1)" }}
                    >
                      🔃
                    </span>
                    =연동(Firebase 계정) ·{" "}
                    <span
                      className="inline-block"
                      style={{ filter: "grayscale(1) brightness(0.9) contrast(1.1)" }}
                    >
                      ⏸️
                    </span>
                    =비연동
                  </p>
                </div>
                <span className="shrink-0 px-1.5 py-0.5 rounded-full text-xs font-medium bg-slate-100 text-slate-600 border border-slate-200">
                  {members.length}명
                </span>
              </div>
              <div className="w-full overflow-x-auto">
                <table className="w-full border-collapse border border-slate-300 text-left">
                  <thead>
                    <tr className="bg-slate-100">
                      <th className="border-l border-slate-300 first:border-l-0 px-1 py-0 text-xs font-semibold text-slate-700 w-10">
                        번호
                      </th>
                      <th className="border-l border-slate-300 px-1 py-0 text-xs font-semibold text-slate-700 min-w-[6rem] w-32">
                        프로필
                      </th>
                      <th className="border-l border-slate-300 px-1 py-0 text-xs font-semibold text-slate-700 min-w-[3rem] w-14">
                        삭제
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {members.map((m, i) => (
                      <tr key={m.id} className="bg-slate-50 even:bg-white">
                        <td className="border-l border-slate-300 first:border-l-0 px-1 py-0 align-middle">
                          <span className="inline-block text-sm leading-tight">
                            {String(i + 1).padStart(2, "0")}
                          </span>
                        </td>
                        <td className="border-l border-slate-300 px-1 py-0 align-middle text-sm font-medium text-slate-800 whitespace-nowrap min-w-0 leading-tight">
                          <span
                            className="tracking-tighter inline-flex items-center gap-0"
                            style={{ letterSpacing: "-0.02em" }}
                          >
                            {m.name}
                            <span
                              className="shrink-0 inline-block w-[0.65em] overflow-visible align-middle"
                              style={{ lineHeight: 0 }}
                              title={m.linkedUid ? "Firebase 계정 연동 · 공동편집·통계 연동 가능" : "비연동"}
                              aria-label={m.linkedUid ? "연동" : "비연동"}
                            >
                              <span
                                className="inline-block origin-left"
                                style={{
                                  transform: "scale(0.65)",
                                  transformOrigin: "left center",
                                  filter: "grayscale(1) brightness(0.9) contrast(1.1)",
                                }}
                              >
                                {m.linkedUid ? "🔃" : "⏸️"}
                              </span>
                            </span>
                            <span
                              className="inline-flex items-center gap-0 text-base leading-none origin-left"
                              style={{
                                letterSpacing: "-0.08em",
                                color: m.gender === "F" ? "#e8a4bc" : "#7c9fd8",
                                transform: "scale(0.5)",
                                transformOrigin: "left center",
                              }}
                            >
                              <span className="inline-block">
                                {m.gender === "F" ? "\u2640\uFE0F" : "\u2642\uFE0F"}
                              </span>
                              <span className="inline-block leading-none align-middle text-black">{m.grade}</span>
                            </span>
                          </span>
                        </td>
                        <td className="border-l border-slate-300 px-1 py-0 align-middle">
                          <button
                            type="button"
                            onClick={() => removeMember(m.id)}
                            className="w-6 h-6 flex items-center justify-center text-xs text-slate-500 hover:bg-red-100 hover:text-red-600"
                            aria-label={`${m.name} 제거`}
                          >
                            ×
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="border-t border-[#e8e8ed] px-2 py-2">
                <div className="flex flex-row items-center gap-2 flex-wrap">
                  <span className="text-xs font-medium text-slate-600 shrink-0">인원 추가</span>
                  <input
                    type="text"
                    value={newMemberName}
                    onChange={(e) => setNewMemberName(e.target.value)}
                    placeholder="이름"
                    aria-label="이름"
                    className="flex-1 min-w-[4rem] h-9 px-3 py-0 text-sm rounded-lg border border-[#d2d2d7] bg-[#fbfbfd] text-[#1d1d1f] placeholder:text-[#6e6e73] focus:outline-none focus:ring-2 focus:ring-[#0071e3]/25 focus:border-[#0071e3] box-border"
                  />
                  <select
                    value={newMemberGender}
                    onChange={(e) => setNewMemberGender(e.target.value as "M" | "F")}
                    aria-label="성별"
                    className="shrink-0 w-16 h-9 px-2 py-0 text-sm rounded-lg border border-[#d2d2d7] bg-[#fbfbfd] text-[#1d1d1f] focus:outline-none focus:ring-2 focus:ring-[#0071e3]/25 focus:border-[#0071e3]"
                  >
                    <option value="M">남</option>
                    <option value="F">여</option>
                  </select>
                  <select
                    value={newMemberGrade}
                    onChange={(e) => setNewMemberGrade(e.target.value as Grade)}
                    aria-label="급수"
                    className="shrink-0 w-14 h-9 px-2 py-0 text-sm rounded-lg border border-[#d2d2d7] bg-[#fbfbfd] text-[#1d1d1f] focus:outline-none focus:ring-2 focus:ring-[#0071e3]/25 focus:border-[#0071e3]"
                  >
                    <option value="A">A</option>
                    <option value="B">B</option>
                    <option value="C">C</option>
                    <option value="D">D</option>
                  </select>
                  <button
                    type="button"
                    onClick={() => {
                      const trimmed = newMemberName.trim();
                      if (!trimmed) {
                        alert("이름을 입력해 주세요.");
                        return;
                      }
                      if (members.length >= gameMode.maxPlayers) {
                        alert(`경기 인원은 최대 ${gameMode.maxPlayers}명까지입니다.`);
                        return;
                      }
                      addMember(trimmed, newMemberGender, newMemberGrade);
                      setNewMemberName("");
                    }}
                    className="shrink-0 h-9 px-4 rounded-lg text-sm font-medium text-white bg-[#0071e3] hover:bg-[#0077ed] transition-colors btn-tap"
                  >
                    추가
                  </button>
                </div>
              </div>
              <div className="border-t border-[#e8e8ed] px-2 py-2">
                <button
                  type="button"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    const name = myInfo.name?.trim();
                    if (!name) {
                      alert("경기 이사에서 프로필 이름을 먼저 입력해 주세요.");
                      return;
                    }
                    const uid = myInfo.uid ?? getCurrentUserUid();
                    if (uid && members.some((m) => m.linkedUid === uid)) {
                      alert("이미 명단에 있습니다.");
                      return;
                    }
                    if (!uid && members.some((m) => m.name === name)) {
                      alert("이미 명단에 있습니다.");
                      return;
                    }
                    if (members.length >= gameMode.maxPlayers) {
                      alert(`경기 인원은 최대 ${gameMode.maxPlayers}명까지입니다.`);
                      return;
                    }
                    addMemberAsMe(name, myInfo.gender ?? "M", myInfo.grade ?? "D");
                  }}
                  className="w-full py-2 rounded-xl text-sm font-medium text-[#0071e3] bg-[#0071e3]/10 hover:bg-[#0071e3]/20 transition-colors btn-tap mb-2"
                >
                  프로필로 나 추가
                </button>
                <button
                  type="button"
                  disabled={
                    members.length < gameMode.minPlayers ||
                    members.length > gameMode.maxPlayers ||
                    (matches.length > 0 && !rosterChangedSinceGenerate)
                  }
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (members.length < gameMode.minPlayers || members.length > gameMode.maxPlayers) {
                      alert(`경기 인원은 ${gameMode.minPlayers}~${gameMode.maxPlayers}명이어야 합니다.`);
                      return;
                    }
                    if (matches.length > 0) {
                      setShowRegenerateConfirm(true);
                      return;
                    }
                    doMatch();
                  }}
                  className="w-full py-3 rounded-xl font-semibold text-white transition-colors hover:opacity-95 bg-[#0071e3] hover:bg-[#0077ed] btn-tap disabled:opacity-50 disabled:pointer-events-none disabled:cursor-not-allowed"
                >
                  경기 생성
                </button>
                <p className="text-xs text-slate-500 mt-1.5">
                  <span className="font-numeric">
                    총{members.length}명-총
                    {members.length >= gameMode.minPlayers ? getTargetTotalGames(members.length) : "-"}경기-인당
                    {members.length >= gameMode.minPlayers && getTargetTotalGames(members.length) > 0
                      ? Math.round((getTargetTotalGames(members.length) * 4) / members.length)
                      : "-"}
                    경기
                  </span>
                </p>
                {members.length < gameMode.minPlayers && (
                  <p className="text-xs text-slate-400 mt-1 text-center">
                    경기 인원은{" "}
                    <span className="font-numeric">{gameMode.minPlayers}</span>~
                    <span className="font-numeric">{gameMode.maxPlayers}</span>명이어야 합니다.
                  </p>
                )}
                {members.length > gameMode.maxPlayers && (
                  <p className="text-xs text-slate-400 mt-1 text-center">
                    경기 인원은 <span className="font-numeric">{gameMode.maxPlayers}</span>명까지입니다.
                  </p>
                )}
              </div>
            </div>

            <section id="section-matches" className="scroll-mt-2">
              {matches.length > 0 && (
                <div className="rounded-2xl bg-white shadow-[0_1px_3px_rgba(0,0,0,0.06)] border border-[#e8e8ed] overflow-hidden mt-2">
                  <div className="px-2 py-1.5 border-b border-[#e8e8ed]">
                    <h3 className="text-base font-semibold text-slate-800">경기 현황</h3>
                    {(() => {
                      const ids = new Set<string>();
                      matches.forEach((m: Match) => {
                        ids.add(m.team1.players[0].id);
                        ids.add(m.team1.players[1].id);
                        ids.add(m.team2.players[0].id);
                        ids.add(m.team2.players[1].id);
                      });
                      const memberCount = ids.size;
                      const perPerson = memberCount > 0 ? Math.round((matches.length * 4) / memberCount) : 0;
                      return (
                        <p className="text-xs text-slate-500 mt-0.5">
                          <span className="font-numeric">
                            총{memberCount}명-총{matches.length}경기-인당{perPerson}경기
                          </span>
                        </p>
                      );
                    })()}
                  </div>
                  <div className="px-2 py-1 border-b border-[#e8e8ed]">
                    {(() => {
                      const total = matches.length;
                      const completedCount = matches.filter((m) => m.score1 != null && m.score2 != null).length;
                      const ongoingCount = playingMatches.length;
                      const waitingCount = total - completedCount - ongoingCount;
                      const pct = (n: number) => (total ? Math.round((n / total) * 100) : 0);
                      return (
                        <table className="w-full text-sm border border-slate-200 rounded overflow-hidden font-numeric table-fixed border-collapse">
                          <tbody className="bg-white text-slate-700">
                            <tr className="bg-slate-100 text-slate-600">
                              <th className="py-0.5 px-1 text-center font-medium w-1/4 border-r border-slate-200">
                                총
                              </th>
                              <th className="py-0.5 px-1 text-center font-medium w-1/4 border-r border-slate-200">
                                종료
                              </th>
                              <th className="py-0.5 px-1 text-center font-medium w-1/4 border-r border-slate-200">
                                진행
                              </th>
                              <th className="py-0.5 px-1 text-center font-medium w-1/4">대기</th>
                            </tr>
                            <tr className="border-t border-slate-200">
                              <td className="py-0.5 px-1 text-center font-medium border-r border-slate-200">
                                {total}
                              </td>
                              <td className="py-0.5 px-1 text-center font-medium border-r border-slate-200">
                                {completedCount}
                              </td>
                              <td className="py-0.5 px-1 text-center font-medium border-r border-slate-200">
                                {ongoingCount}
                              </td>
                              <td className="py-0.5 px-1 text-center font-medium">{waitingCount}</td>
                            </tr>
                            <tr className="border-t border-slate-200">
                              <td className="py-0.5 px-1 text-center text-slate-500 font-normal border-r border-slate-200">
                                {pct(total)}%
                              </td>
                              <td className="py-0.5 px-1 text-center text-slate-500 font-normal border-r border-slate-200">
                                {pct(completedCount)}%
                              </td>
                              <td className="py-0.5 px-1 text-center text-slate-500 font-normal border-r border-slate-200">
                                {pct(ongoingCount)}%
                              </td>
                              <td className="py-0.5 px-1 text-center text-slate-500 font-normal">
                                {pct(waitingCount)}%
                              </td>
                            </tr>
                          </tbody>
                        </table>
                      );
                    })()}
                    {playingMatches.length > 0 && (
                      <p className="text-fluid-xs text-slate-400 mt-1">
                        진행 뱃지 다시 눌러 해제 · 가능{" "}
                        <span className="font-numeric">{playableMatches.length}</span>경기
                      </p>
                    )}
                  </div>
                  <div className="divide-y divide-slate-100">
                    {matches.map((m, index) => {
                      const isDone = m.score1 !== null && m.score2 !== null;
                      const isCurrent = !isDone && playingMatchIdsSet.has(String(m.id));
                      const isPlayable =
                        !isDone && !isCurrent && playableMatchIdsSet.has(String(m.id));
                      const statusLabel = isDone
                        ? "종료"
                        : isCurrent
                          ? "진행"
                          : isPlayable
                            ? "가능"
                            : "대기";
                      const statusColor = isDone
                        ? "bg-slate-200 text-slate-600"
                        : isCurrent
                          ? "bg-amber-100 text-amber-700 border border-amber-200"
                          : isPlayable
                            ? "bg-green-500 text-white border border-green-600 font-semibold"
                            : "bg-slate-100 text-slate-600";
                      const canSelect = !isDone;
                      const history =
                        m.savedHistory && m.savedHistory.length > 0
                          ? m.savedHistory
                          : m.savedAt
                            ? [{ at: m.savedAt, by: m.savedBy ?? "", savedByName: null }]
                            : [];
                      const lastSaved = history.length > 0 ? history[history.length - 1] : null;
                      const savedByName =
                        lastSaved?.savedByName ??
                        (lastSaved?.by ? members.find((p) => p.id === lastSaved.by)?.name : null);
                      const savedAtStr = lastSaved ? formatSavedAt(lastSaved.at) : "";
                      const statusLine =
                        isDone && (m.score1 ?? 0) === 0 && (m.score2 ?? 0) === 0
                          ? "승패 미반영"
                          : isDone && (m.score1 ?? 0) === (m.score2 ?? 0)
                            ? "승패 미반영 (동점)"
                            : isDone
                              ? `승패 반영 (${(m.score1 ?? 0) > (m.score2 ?? 0) ? "왼쪽 승" : "오른쪽 승"})`
                              : null;
                      const hasInfoLine =
                        (savedByName != null || savedAtStr) || statusLine != null;
                      return (
                        <div
                          key={m.id}
                          className={`flex flex-col gap-0.5 px-0.5 py-0.5 ${isCurrent ? "bg-amber-50/50" : isPlayable ? "bg-green-50/90 ring-1 ring-green-300/60 rounded-r-lg" : "bg-white hover:bg-slate-50/80"}`}
                        >
                          <div
                            className={`flex flex-nowrap items-center gap-x-1 text-sm overflow-x-auto ${isCurrent ? "hover:bg-amber-50/70" : ""}`}
                          >
                            <span className="shrink-0 text-sm font-semibold text-slate-600 min-w-[1.25rem]">
                              {String(index + 1).padStart(2, "0")}
                            </span>
                            <button
                              type="button"
                              onClick={() => canSelect && togglePlayingMatch(m.id)}
                              title={canSelect ? (isCurrent ? "진행 해제" : "진행으로 선택") : undefined}
                              className={`shrink-0 min-w-[2rem] px-1 py-0.5 rounded text-xs font-medium flex flex-row items-center justify-center gap-0 leading-none ${statusColor} ${canSelect ? "cursor-pointer hover:opacity-80" : "cursor-default"}`}
                            >
                              {statusLabel}
                            </button>
                            <div className="min-w-0 flex-1 flex flex-col justify-center text-left max-w-[5.5rem] gap-0 overflow-hidden">
                              {m.team1.players.map((p) => {
                                const isHighlight = p.id === highlightMemberId;
                                return (
                                  <button
                                    key={p.id}
                                    type="button"
                                    onClick={() =>
                                      setHighlightMemberId((prev) => (prev === p.id ? null : p.id))
                                    }
                                    className={`block w-full text-left text-sm leading-none truncate rounded px-0.5 -mx-0.5 font-medium text-slate-700 hover:bg-slate-100 ${highlightMemberId && !isHighlight ? "opacity-90" : ""}`}
                                    title={
                                      isHighlight
                                        ? "클릭 시 하이라이트 해제"
                                        : `${p.name} 클릭 시 이 선수 경기만 하이라이트 (같은 줄 왼쪽=파트너, 오른쪽=상대)`
                                    }
                                  >
                                    <span
                                      className={`tracking-tighter inline-flex items-center gap-0 truncate text-sm ${isHighlight ? "bg-amber-400 text-amber-900 font-bold ring-1 ring-amber-500 rounded px-0.5" : ""}`}
                                      style={{ letterSpacing: "-0.02em" }}
                                    >
                                      {p.name}
                                      <span
                                        className="shrink-0 inline-block w-[0.65em] overflow-visible align-middle"
                                        style={{ lineHeight: 0 }}
                                        title={p.linkedUid ? "Firebase 계정 연동 · 공동편집·통계 연동 가능" : "비연동"}
                                        aria-label={p.linkedUid ? "연동" : "비연동"}
                                      >
                                        <span
                                          className="inline-block origin-left"
                                          style={{
                                            transform: "scale(0.65)",
                                            transformOrigin: "left center",
                                            filter: "grayscale(1) brightness(0.9) contrast(1.1)",
                                          }}
                                        >
                                          {p.linkedUid ? "🔃" : "⏸️"}
                                        </span>
                                      </span>
                                      <span
                                        className="inline-flex items-center gap-0 text-base leading-none origin-left"
                                        style={{
                                          letterSpacing: "-0.08em",
                                          color: p.gender === "F" ? "#e8a4bc" : "#7c9fd8",
                                          transform: "scale(0.5)",
                                          transformOrigin: "left center",
                                        }}
                                      >
                                        <span className="inline-block">
                                          {p.gender === "F" ? "\u2640\uFE0F" : "\u2642\uFE0F"}
                                        </span>
                                        <span className="inline-block leading-none align-middle text-black">
                                          {p.grade}
                                        </span>
                                      </span>
                                    </span>
                                  </button>
                                );
                              })}
                            </div>
                            <div className="shrink-0 w-12 flex items-center justify-center">
                              <div className="flex items-center gap-0">
                                <input
                                  type="number"
                                  min={0}
                                  max={scoreLimit}
                                  placeholder="0"
                                  value={scoreInputs[m.id]?.s1 ?? (m.score1 != null ? String(m.score1) : "")}
                                  onChange={(e) => {
                                    let v = e.target.value;
                                    const n = parseInt(v, 10);
                                    if (v !== "" && !Number.isNaN(n) && n > scoreLimit) v = String(scoreLimit);
                                    updateScoreInput(m.id, "s1", v);
                                  }}
                                  className="w-9 h-7 rounded border border-slate-200 bg-slate-50 text-slate-800 text-center text-sm font-medium font-numeric focus:outline-none focus:ring-1 focus:ring-blue-200 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                                  aria-label="팀1 득점"
                                  title={`0~${scoreLimit}점 (경기 설정 기준)`}
                                />
                                <span className="text-slate-400 text-sm font-medium">:</span>
                                <input
                                  type="number"
                                  min={0}
                                  max={scoreLimit}
                                  placeholder="0"
                                  value={scoreInputs[m.id]?.s2 ?? (m.score2 != null ? String(m.score2) : "")}
                                  onChange={(e) => {
                                    let v = e.target.value;
                                    const n = parseInt(v, 10);
                                    if (v !== "" && !Number.isNaN(n) && n > scoreLimit) v = String(scoreLimit);
                                    updateScoreInput(m.id, "s2", v);
                                  }}
                                  className="w-9 h-7 rounded border border-slate-200 bg-slate-50 text-slate-800 text-center text-sm font-medium font-numeric focus:outline-none focus:ring-1 focus:ring-blue-200 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                                  aria-label="팀2 득점"
                                  title={`0~${scoreLimit}점 (경기 설정 기준)`}
                                />
                              </div>
                            </div>
                            <div className="min-w-0 flex-1 flex flex-col justify-center text-right max-w-[5.5rem] gap-0 overflow-hidden">
                              {m.team2.players.map((p) => {
                                const isHighlight = p.id === highlightMemberId;
                                return (
                                  <button
                                    key={p.id}
                                    type="button"
                                    onClick={() =>
                                      setHighlightMemberId((prev) => (prev === p.id ? null : p.id))
                                    }
                                    className={`block w-full text-right text-sm leading-none truncate rounded px-0.5 -mx-0.5 font-medium text-slate-700 hover:bg-slate-100 ${highlightMemberId && !isHighlight ? "opacity-90" : ""}`}
                                    title={
                                      isHighlight
                                        ? "클릭 시 하이라이트 해제"
                                        : `${p.name} 클릭 시 이 선수 경기만 하이라이트 (같은 줄 왼쪽=파트너, 오른쪽=상대)`
                                    }
                                  >
                                    <span
                                      className={`tracking-tighter inline-flex items-center gap-0 truncate text-sm justify-end ${isHighlight ? "bg-amber-400 text-amber-900 font-bold ring-1 ring-amber-500 rounded px-0.5" : ""}`}
                                      style={{ letterSpacing: "-0.02em" }}
                                    >
                                      {p.name}
                                      <span
                                        className="shrink-0 inline-block w-[0.65em] overflow-visible align-middle"
                                        style={{ lineHeight: 0 }}
                                        title={p.linkedUid ? "Firebase 계정 연동 · 공동편집·통계 연동 가능" : "비연동"}
                                        aria-label={p.linkedUid ? "연동" : "비연동"}
                                      >
                                        <span
                                          className="inline-block origin-left"
                                          style={{
                                            transform: "scale(0.65)",
                                            transformOrigin: "left center",
                                            filter: "grayscale(1) brightness(0.9) contrast(1.1)",
                                          }}
                                        >
                                          {p.linkedUid ? "🔃" : "⏸️"}
                                        </span>
                                      </span>
                                      <span
                                        className="inline-flex items-center gap-0 text-base leading-none origin-left"
                                        style={{
                                          letterSpacing: "-0.08em",
                                          color: p.gender === "F" ? "#e8a4bc" : "#7c9fd8",
                                          transform: "scale(0.5)",
                                          transformOrigin: "left center",
                                        }}
                                      >
                                        <span className="inline-block">
                                          {p.gender === "F" ? "\u2640\uFE0F" : "\u2642\uFE0F"}
                                        </span>
                                        <span className="inline-block leading-none align-middle text-black">
                                          {p.grade}
                                        </span>
                                      </span>
                                    </span>
                                  </button>
                                );
                              })}
                            </div>
                            <button
                              type="button"
                              onClick={() => saveResult(m.id)}
                              className="shrink-0 min-w-[2rem] px-1 py-1 rounded text-xs font-semibold leading-none text-white bg-[#0071e3] hover:bg-[#0077ed] transition-colors flex flex-row items-center justify-center"
                            >
                              저장
                            </button>
                          </div>
                          {hasInfoLine && (
                            <p
                              className="text-fluid-xs text-slate-500 pl-10 leading-tight flex items-center gap-1.5 flex-wrap"
                              title={lastSaved ? new Date(lastSaved.at).toLocaleString("ko-KR") : ""}
                            >
                              {(savedByName != null || savedAtStr) && (
                                <span className="font-medium text-slate-600">
                                  {savedByName ?? "—"} {savedAtStr}
                                </span>
                              )}
                              {statusLine != null && (
                                <span className="text-amber-600 font-medium">{statusLine}</span>
                              )}
                            </p>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </section>

            <section id="section-ranking" className="scroll-mt-2">
              <div className="rounded-2xl bg-white shadow-[0_1px_3px_rgba(0,0,0,0.06)] border border-[#e8e8ed] overflow-hidden">
                <div className="px-2 py-1.5 border-b border-[#e8e8ed]">
                  <h3 className="text-base font-semibold text-slate-800">경기 결과</h3>
                  <p className="text-xs text-slate-500 mt-0.5">
                    경기 현황에서 진행한 경기 점수로 산출됩니다. 승수·득실차·급수 순으로 정렬됩니다.
                  </p>
                </div>
                {matches.length === 0 ? (
                  <p className="px-2 py-4 text-sm text-slate-500 text-center">
                    경기 명단으로 경기 생성 후, 경기 현황에서 점수를 입력하면 여기에 결과가 표시됩니다.
                  </p>
                ) : (
                  <ul className="divide-y divide-slate-100">
                    {ranking.map((m, i) => {
                      const rank = i + 1;
                      const isTop3 = rank <= 3;
                      const rowBg =
                        rank === 1
                          ? "bg-amber-50/80"
                          : rank === 2
                            ? "bg-slate-100/80"
                            : rank === 3
                              ? "bg-amber-100/50"
                              : "hover:bg-slate-50/80";
                      const medalColor = rank === 1 ? "#E5A00D" : rank === 2 ? "#94A3B8" : "#B45309";
                      const medalStroke = rank === 1 ? "#C4890C" : rank === 2 ? "#64748B" : "#92400E";
                      return (
                        <li
                          key={m.id}
                          className={`flex items-center gap-2 px-2 py-0.5 min-h-0 leading-tight ${rowBg}`}
                        >
                          <span className="w-8 h-6 flex items-center justify-center flex-shrink-0">
                            {isTop3 ? (
                              <span
                                className="relative inline-flex items-center justify-center"
                                aria-label={`${rank}위`}
                              >
                                <svg
                                  width="24"
                                  height="26"
                                  viewBox="0 0 24 26"
                                  fill="none"
                                  xmlns="http://www.w3.org/2000/svg"
                                  className="drop-shadow-md"
                                >
                                  <defs>
                                    <linearGradient
                                      id={`medalGrad${rank}`}
                                      x1="0%"
                                      y1="0%"
                                      x2="100%"
                                      y2="100%"
                                    >
                                      <stop
                                        offset="0%"
                                        stopColor={
                                          rank === 1 ? "#FFF4B8" : rank === 2 ? "#E8ECF1" : "#E8C89C"
                                        }
                                      />
                                      <stop offset="35%" stopColor={medalColor} />
                                      <stop offset="70%" stopColor={medalStroke} />
                                      <stop
                                        offset="100%"
                                        stopColor={
                                          rank === 1 ? "#B8860B" : rank === 2 ? "#64748B" : "#783F04"
                                        }
                                      />
                                    </linearGradient>
                                    <linearGradient
                                      id={`medalShine${rank}`}
                                      x1="0%"
                                      y1="0%"
                                      x2="100%"
                                      y2="100%"
                                    >
                                      <stop offset="0%" stopColor="rgba(255,255,255,0.65)" />
                                      <stop offset="50%" stopColor="rgba(255,255,255,0.15)" />
                                      <stop offset="100%" stopColor="rgba(255,255,255,0)" />
                                    </linearGradient>
                                    <linearGradient
                                      id={`ringGrad${rank}`}
                                      x1="0%"
                                      y1="0%"
                                      x2="0%"
                                      y2="100%"
                                    >
                                      <stop
                                        offset="0%"
                                        stopColor={
                                          rank === 1 ? "#D4A017" : rank === 2 ? "#94A3B8" : "#A0522D"
                                        }
                                      />
                                      <stop offset="100%" stopColor={medalStroke} />
                                    </linearGradient>
                                    <filter
                                      id={`medalShadow${rank}`}
                                      x="-20%"
                                      y="-20%"
                                      width="140%"
                                      height="140%"
                                    >
                                      <feDropShadow
                                        dx="0"
                                        dy="1"
                                        stdDeviation="0.8"
                                        floodColor="rgba(0,0,0,0.25)"
                                      />
                                    </filter>
                                  </defs>
                                  <g filter={`url(#medalShadow${rank})`}>
                                    <rect
                                      x="9"
                                      y="0.5"
                                      width="6"
                                      height="2.5"
                                      rx="1.25"
                                      fill={`url(#ringGrad${rank})`}
                                      stroke={medalStroke}
                                      strokeWidth="0.6"
                                    />
                                    <path
                                      d="M 10.5 3 L 11.3 4.5 L 12 4.2 L 12.7 4.5 L 13.5 3 L 12 4 Z"
                                      fill={`url(#ringGrad${rank})`}
                                      stroke={medalStroke}
                                      strokeWidth="0.4"
                                      opacity={0.95}
                                    />
                                    <circle
                                      cx="12"
                                      cy="13"
                                      r="9"
                                      fill={`url(#medalGrad${rank})`}
                                      stroke={medalStroke}
                                      strokeWidth="1.2"
                                    />
                                    <circle
                                      cx="12"
                                      cy="13"
                                      r="7.2"
                                      fill="none"
                                      stroke="rgba(255,255,255,0.5)"
                                      strokeWidth="0.8"
                                    />
                                    <circle
                                      cx="12"
                                      cy="13"
                                      r="5.8"
                                      fill="none"
                                      stroke="rgba(0,0,0,0.12)"
                                      strokeWidth="0.4"
                                    />
                                    <ellipse
                                      cx="12"
                                      cy="10.5"
                                      rx="5"
                                      ry="3"
                                      fill={`url(#medalShine${rank})`}
                                    />
                                    <text
                                      x="12"
                                      y="16"
                                      textAnchor="middle"
                                      fill="#fff"
                                      fontSize="10"
                                      fontWeight="bold"
                                      fontFamily="system-ui"
                                      stroke="rgba(0,0,0,0.2)"
                                      strokeWidth="0.6"
                                    >
                                      {rank}
                                    </text>
                                  </g>
                                </svg>
                              </span>
                            ) : (
                              <span className="text-xs font-medium text-slate-800">{rank}</span>
                            )}
                          </span>
                          <div className="flex-1 min-w-0 flex items-center gap-0 leading-tight">
                            <span
                              className="tracking-tighter inline-flex items-center gap-0 font-medium text-slate-800 text-sm"
                              style={{ letterSpacing: "-0.02em" }}
                            >
                              {m.name}
                              <span
                                className="shrink-0 inline-block w-[0.65em] overflow-visible align-middle"
                                style={{ lineHeight: 0 }}
                                title={m.linkedUid ? "Firebase 계정 연동 · 공동편집·통계 연동 가능" : "비연동"}
                                aria-label={m.linkedUid ? "연동" : "비연동"}
                              >
                                <span
                                  className="inline-block origin-left"
                                  style={{
                                    transform: "scale(0.65)",
                                    transformOrigin: "left center",
                                    filter: "grayscale(1) brightness(0.9) contrast(1.1)",
                                  }}
                                >
                                  {m.linkedUid ? "🔃" : "⏸️"}
                                </span>
                              </span>
                              <span
                                className="inline-flex items-center gap-0 text-base leading-none origin-left"
                                style={{
                                  letterSpacing: "-0.08em",
                                  color: m.gender === "F" ? "#e8a4bc" : "#7c9fd8",
                                  transform: "scale(0.5)",
                                  transformOrigin: "left center",
                                }}
                              >
                                <span className="inline-block">
                                  {m.gender === "F" ? "\u2640\uFE0F" : "\u2642\uFE0F"}
                                </span>
                                <span className="inline-block leading-none align-middle text-black">
                                  {m.grade}
                                </span>
                              </span>
                            </span>
                          </div>
                          <div className="text-right text-xs text-slate-600 leading-tight">
                            <span className="font-medium text-slate-700">{m.wins}승</span>
                            <span className="text-slate-400 mx-1">/</span>
                            <span className="text-slate-600">{m.losses}패</span>
                            <span className="text-slate-500 ml-1.5">
                              {m.pointDiff >= 0 ? "+" : ""}
                              {m.pointDiff}
                            </span>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            </section>
          </div>
        </div>
      )}
    </div>
  );
}
