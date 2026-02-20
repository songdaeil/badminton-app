"use client";

interface HelpModalsProps {
  showGameModeHelp: boolean;
  showRecordHelp: boolean;
  onCloseGameModeHelp: () => void;
  onCloseRecordHelp: () => void;
  overlayTouchStartRef: React.MutableRefObject<{ x: number; y: number }>;
}

export function HelpModals({
  showGameModeHelp,
  showRecordHelp,
  onCloseGameModeHelp,
  onCloseRecordHelp,
  overlayTouchStartRef,
}: HelpModalsProps) {
  const handleSwipeClose = (onClose: () => void) => (e: React.TouchEvent) => {
    const dy = e.changedTouches[0].clientY - overlayTouchStartRef.current.y;
    const dx = e.changedTouches[0].clientX - overlayTouchStartRef.current.x;
    if (dy > 50 && Math.abs(dy) > Math.abs(dx)) onClose();
  };

  return (
    <>
      {showGameModeHelp && (
        <>
          <div className="fixed inset-0 z-30 bg-black/20" aria-hidden onClick={onCloseGameModeHelp} />
          <div
            className="fixed left-1/2 top-1/2 z-40 w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-2xl bg-white p-4 shadow-xl border border-[#e8e8ed]"
            onTouchStart={(e) => { overlayTouchStartRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY }; }}
            onTouchEnd={handleSwipeClose(onCloseGameModeHelp)}
          >
            <p className="text-sm text-slate-700 leading-relaxed">
              각 카테고리 내에 여러 개의 경기 방식을 업데이트 중에 있습니다. 설명을 읽고 원하는 경기 방식을 선택하여 경기 목록으로 이동시킬 수 있습니다.
            </p>
            <button
              type="button"
              onClick={onCloseGameModeHelp}
              className="mt-3 w-full py-2 rounded-xl text-sm font-medium bg-slate-100 text-slate-700 hover:bg-slate-200 transition-colors"
            >
              닫기
            </button>
          </div>
        </>
      )}

      {showRecordHelp && (
        <>
          <div className="fixed inset-0 z-30 bg-black/20" aria-hidden onClick={onCloseRecordHelp} />
          <div
            className="fixed left-1/2 top-1/2 z-40 w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-2xl bg-white p-4 shadow-xl border border-[#e8e8ed]"
            onTouchStart={(e) => { overlayTouchStartRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY }; }}
            onTouchEnd={handleSwipeClose(onCloseRecordHelp)}
          >
            <p className="text-sm text-slate-700 leading-relaxed">
              선택한 경기 방식이 경기 목록에 추가됩니다. 원하는 경기를 누르면 상세가 열려 편집할 수 있습니다. 공유 링크를 참가자에게 전달하면, 받은 사람은 경기 명단에 신청(참가자 추가)하고 경기 현황에서 경기 결과를 함께 입력할 수 있습니다.
            </p>
            <button
              type="button"
              onClick={onCloseRecordHelp}
              className="mt-3 w-full py-2 rounded-xl text-sm font-medium bg-slate-100 text-slate-700 hover:bg-slate-200 transition-colors"
            >
              닫기
            </button>
          </div>
        </>
      )}
    </>
  );
}
