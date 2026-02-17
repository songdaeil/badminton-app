"use client";

import { useSearchParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { getKakaoRedirectUri } from "@/lib/kakao";

const KAKAO_PROFILE_PENDING_KEY = "kakao_profile_pending";
const KAKAO_RETURN_TO_MYINFO_KEY = "kakao_return_to_myinfo";

export default function AuthKakaoCallbackPage() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const [status, setStatus] = useState<"loading" | "ok" | "error">("loading");
  const [message, setMessage] = useState("로그인 처리 중...");

  useEffect(() => {
    const code = searchParams.get("code");
    const error = searchParams.get("error");
    const errorDescription = searchParams.get("error_description");

    if (error) {
      setMessage(errorDescription || error || "로그인이 취소되었습니다.");
      setStatus("error");
      return;
    }

    if (!code) {
      setMessage("인가 코드가 없습니다.");
      setStatus("error");
      return;
    }

    const redirectUri = getKakaoRedirectUri();

    fetch("/api/auth/kakao/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, redirect_uri: redirectUri }),
    })
      .then(async (res) => {
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || "토큰 발급 실패");
        }
        return res.json();
      })
      .then((data: { nickname?: string; email?: string; profileImageUrl?: string }) => {
        try {
          sessionStorage.setItem(
            KAKAO_PROFILE_PENDING_KEY,
            JSON.stringify({
              nickname: data.nickname ?? "",
              email: data.email ?? "",
              profileImageUrl: data.profileImageUrl ?? "",
            })
          );
          sessionStorage.setItem(KAKAO_RETURN_TO_MYINFO_KEY, "1");
        } catch {
          // sessionStorage 불가 시 무시
        }
        setStatus("ok");
        setMessage("로그인되었습니다. 메인으로 이동합니다.");
        router.replace("/");
      })
      .catch((err) => {
        setMessage(err?.message || "로그인 처리에 실패했습니다.");
        setStatus("error");
      });
  }, [searchParams, router]);

  return (
    <div className="min-h-[40vh] flex flex-col items-center justify-center p-4">
      {status === "loading" && (
        <p className="text-slate-600 text-sm animate-pulse">{message}</p>
      )}
      {status === "ok" && (
        <p className="text-slate-700 text-sm">{message}</p>
      )}
      {status === "error" && (
        <>
          <p className="text-amber-700 text-sm mb-4">{message}</p>
          <button
            type="button"
            onClick={() => router.replace("/")}
            className="px-4 py-2 rounded-lg text-sm font-medium bg-slate-200 text-slate-800 hover:bg-slate-300"
          >
            메인으로 돌아가기
          </button>
        </>
      )}
    </div>
  );
}
