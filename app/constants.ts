/** 앱 전역 UI/세션 상수 */

export const PRIMARY = "#0071e3";
export const PRIMARY_LIGHT = "rgba(0, 113, 227, 0.08)";

/** 로그인 게이트 통과 여부 세션 스토리지 키 */
export const LOGIN_GATE_KEY = "badminton_login_passed";

/** 하단 네비 탭 순서 */
export type NavView = "setting" | "record" | "myinfo";
export const NAV_ORDER: NavView[] = ["setting", "record", "myinfo"];

/** 공유 링크 대기용 세션 스토리지 키 (로그인 전 ?share= 진입 시 저장) */
export const PENDING_SHARE_KEY = "badminton_pending_share";

/** 로그인 후 프로필 업로드 완료 여부 로컬 스토리지 키 */
export const PROFILE_UPLOADED_KEY = "badminton_profile_uploaded";
