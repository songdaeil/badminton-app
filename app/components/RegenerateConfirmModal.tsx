"use client";

interface RegenerateConfirmModalProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  overlayTouchStartRef: React.MutableRefObject<{ x: number; y: number }>;
}

export function RegenerateConfirmModal({
  open,
  onClose,
  onConfirm,
  overlayTouchStartRef,
}: RegenerateConfirmModalProps) {
  if (!open) return null;

  const handleTouchEnd = (e: React.TouchEvent) => {
    const dy = e.changedTouches[0].clientY - overlayTouchStartRef.current.y;
    const dx = e.changedTouches[0].clientX - overlayTouchStartRef.current.x;
    if (dy > 50 && Math.abs(dy) > Math.abs(dx)) onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 animate-fade-in" aria-modal="true" role="alertdialog" aria-labelledby="regenerate-confirm-title">
      <div
        className="bg-white rounded-2xl shadow-xl max-w-sm w-full p-4 space-y-3 animate-scale-in"
        onTouchStart={(e) => { overlayTouchStartRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY }; }}
        onTouchEnd={handleTouchEnd}
      >
        <p id="regenerate-confirm-title" className="text-sm text-slate-700 leading-relaxed">
          현재 진행중인 경기 현황을 초기화가 됩니다. 진행하시겠습니까?
        </p>
        <div className="flex gap-2 justify-end">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-xl text-sm font-medium text-slate-700 bg-slate-100 hover:bg-slate-200"
          >
            취소
          </button>
          <button
            type="button"
            onClick={() => {
              onConfirm();
              onClose();
            }}
            className="px-4 py-2 rounded-xl text-sm font-semibold text-white bg-[#0071e3] hover:bg-[#0077ed]"
          >
            계속
          </button>
        </div>
      </div>
    </div>
  );
}
