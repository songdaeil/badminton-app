"use client";

import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "badminton_pwa_prompt_dismissed";

/** PWA(홈 화면 추가)로 실행 중인지 여부 */
function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  const nav = window.navigator as { standalone?: boolean };
  if (nav.standalone === true) return true; // iOS Safari
  if (window.matchMedia("(display-mode: standalone)").matches) return true;
  return false;
}

/** iOS Safari 여부 (수동 "홈 화면에 추가" 안내용) */
function isIos(): boolean {
  if (typeof window === "undefined") return false;
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

export function PwaInstallPrompt() {
  const [deferredPrompt, setDeferredPrompt] = useState<{ prompt: () => Promise<{ outcome: string }> } | null>(null);
  const [showBanner, setShowBanner] = useState(false);
  const [showIosModal, setShowIosModal] = useState(false);
  const [showManualModal, setShowManualModal] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (isStandalone()) return;
    try {
      const dismissed = localStorage.getItem(STORAGE_KEY);
      if (dismissed === "1") return;
    } catch {
      return;
    }

    const handler = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e as unknown as { prompt: () => Promise<{ outcome: string }> });
    };
    window.addEventListener("beforeinstallprompt", handler);

    // 약간 지연 후 배너 표시 (첫 화면 로딩 후)
    const t = setTimeout(() => setShowBanner(true), 1500);

    return () => {
      window.removeEventListener("beforeinstallprompt", handler);
      clearTimeout(t);
    };
  }, []);

  const handleInstallClick = useCallback(async () => {
    if (deferredPrompt) {
      try {
        await deferredPrompt.prompt();
        setDeferredPrompt(null);
        setShowBanner(false);
        try {
          localStorage.setItem(STORAGE_KEY, "1");
        } catch {}
      } catch {
        setShowBanner(false);
      }
      return;
    }
    if (isIos()) {
      setShowIosModal(true);
    } else {
      setShowManualModal(true);
    }
  }, [deferredPrompt]);

  const handleDismiss = useCallback(() => {
    setShowBanner(false);
    try {
      localStorage.setItem(STORAGE_KEY, "1");
    } catch {}
  }, []);

  const closeIosModal = useCallback(() => setShowIosModal(false), []);
  const closeManualModal = useCallback(() => setShowManualModal(false), []);

  if (!showBanner && !showIosModal && !showManualModal) return null;

  return (
    <>
      {showBanner && (
        <div
          className="fixed top-0 left-0 right-0 z-30 max-w-md mx-auto px-3 pt-2 pb-2 safe-area-pt"
          role="region"
          aria-label="앱 설치 안내"
        >
          <div className="flex items-center gap-2 rounded-xl bg-[#0071e3] text-white shadow-lg px-3 py-3 text-base">
            <span className="flex-1 min-w-0 font-medium truncate">
              앱처럼 쓰려면 홈 화면에 추가하세요
            </span>
            <button
              type="button"
              onClick={handleInstallClick}
              className="shrink-0 px-3 py-2.5 min-h-11 rounded-lg font-semibold bg-white text-[#0071e3] hover:bg-slate-100 transition-colors"
            >
              추가하기
            </button>
            <button
              type="button"
              onClick={handleDismiss}
              className="shrink-0 w-11 h-11 flex items-center justify-center rounded-full hover:bg-white/20 transition-colors text-base"
              aria-label="닫기"
            >
              ×
            </button>
          </div>
        </div>
      )}

      {showIosModal && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center p-4 bg-black/50 animate-fade-in"
          aria-modal="true"
          role="dialog"
          aria-labelledby="pwa-ios-title"
        >
          <div className="w-full max-w-sm rounded-t-2xl bg-white shadow-xl p-4 pb-8 safe-area-pb animate-slide-up">
            <h2 id="pwa-ios-title" className="text-base font-semibold text-slate-800 mb-2">
              홈 화면에 추가
            </h2>
            <ol className="text-base text-slate-600 space-y-2 list-decimal list-inside mb-4">
              <li>Safari 하단 <strong>공유</strong> 버튼(□↑)을 누르세요.</li>
              <li>목록에서 <strong>「홈 화면에 추가」</strong>를 누르세요.</li>
              <li>이름 확인 후 <strong>「추가」</strong>를 누르면 끝입니다.</li>
            </ol>
            <p className="text-base text-slate-500 mb-4">
              Chrome이 아닌 <strong>Safari</strong>에서 열어야 이 메뉴가 보입니다.
            </p>
            <button
              type="button"
              onClick={closeIosModal}
              className="w-full py-3 min-h-11 rounded-xl font-medium bg-[#0071e3] text-white"
            >
              확인
            </button>
          </div>
        </div>
      )}

      {showManualModal && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center p-4 bg-black/50 animate-fade-in"
          aria-modal="true"
          role="dialog"
          aria-labelledby="pwa-manual-title"
        >
          <div className="w-full max-w-sm rounded-t-2xl bg-white shadow-xl p-4 pb-8 safe-area-pb animate-slide-up">
            <h2 id="pwa-manual-title" className="text-base font-semibold text-slate-800 mb-2">
              앱으로 설치하기
            </h2>
            <p className="text-base text-slate-600 mb-3">
              <strong>Chrome</strong>: 주소창 오른쪽의 <strong>⊕ 설치</strong> 아이콘을 누르거나, 메뉴(⋮) → <strong>앱 설치</strong> / <strong>홈 화면에 추가</strong>를 선택하세요.
            </p>
            <p className="text-base text-slate-600 mb-4">
              <strong>Edge</strong>: 주소창 옆 <strong>⊕</strong> 또는 메뉴 → <strong>앱</strong> → 이 사이트를 앱으로 설치하세요.
            </p>
            <p className="text-base text-slate-500 mb-4">
              HTTPS로 배포된 사이트에서만 설치 버튼이 보일 수 있습니다.
            </p>
            <button
              type="button"
              onClick={closeManualModal}
              className="w-full py-3 min-h-11 rounded-xl font-medium bg-[#0071e3] text-white"
            >
              확인
            </button>
          </div>
        </div>
      )}
    </>
  );
}
