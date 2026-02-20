/** 앱 전역 UI/세션 상수 */

export const PRIMARY = "#0071e3";
export const PRIMARY_LIGHT = "rgba(0, 113, 227, 0.08)";

/** 로그인 게이트 통과 여부 세션 스토리지 키 */
export const LOGIN_GATE_KEY = "badminton_login_passed";

/** 하단 네비 탭 순서 */
export type NavView = "setting" | "record" | "myinfo";
export const NAV_ORDER: NavView[] = ["setting", "record", "myinfo"];
