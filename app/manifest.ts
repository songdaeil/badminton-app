import type { MetadataRoute } from "next";

/**
 * PWA 웹 앱 매니페스트.
 * 홈 화면에 추가 시 주소창·브라우저 UI 없이 앱처럼 실행됩니다.
 * public/icon-192.png, icon-512.png 를 추가하면 홈 화면 아이콘이 더 선명해집니다.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "배드민턴 경기",
    short_name: "배드민턴",
    description: "개인전 기반 매칭 및 오늘의 랭킹",
    start_url: "/",
    display: "standalone",
    background_color: "#f5f5f7",
    theme_color: "#0071e3",
    orientation: "portrait",
    icons: [
      { src: "/next.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
    ],
  };
}
