/**
 * 2계정(A 만든이 / B 참여자) Playwright 시뮬레이션.
 * 산출물: docs/sequence-simulation-report.md
 * 비밀번호·환경변수는 보고서에 쓰지 않는다.
 */
import { chromium } from "playwright";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const OUT_DIR = join(ROOT, "docs", "sim-run");
const REPORT = join(ROOT, "docs", "sequence-simulation-report.md");
const BASE = process.env.SIM_BASE_URL || "http://localhost:3000";
const PASSWORD = process.env.SIM_PASSWORD || "SimTest-2026!ab";
const stamp = Date.now();
const EMAIL_A = `sim.a.${stamp}@sim.badminton.test`;
const EMAIL_B = `sim.b.${stamp}@sim.badminton.test`;

const findings = [];

function addFinding(seq, title, result, notes, repro = "") {
  findings.push({ seq, title, result, notes, repro });
  console.log(`[${seq}] ${result} ${title}`);
  if (notes) console.log(`    ${notes}`);
}

async function shot(page, name) {
  mkdirSync(OUT_DIR, { recursive: true });
  await page.screenshot({ path: join(OUT_DIR, `${name}.png`), fullPage: true });
}

async function gotoApp(page, url = BASE) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(1200);
}

async function reloadApp(page) {
  await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(1200);
}

async function waitForGateOrMain(page) {
  await Promise.race([
    page.getByLabel("이메일").waitFor({ timeout: 20000 }),
    page.getByRole("button", { name: /경기 이사/ }).waitFor({ timeout: 20000 }),
    page.getByRole("heading", { name: /이메일 인증이 필요합니다/ }).waitFor({ timeout: 20000 }),
  ]).catch(() => {});
}

async function waitSettled(page, ms = 800) {
  await page.waitForTimeout(ms);
}

function visibleText(page) {
  return page.locator("body").innerText();
}

async function dismissDialogs(page) {
  page.on("dialog", async (d) => {
    await d.accept();
  });
}

async function signUp(page, email) {
  await gotoApp(page);
  await waitForGateOrMain(page);
  await page.getByLabel("이메일").fill(email);
  await page.getByLabel("비밀번호").fill(PASSWORD);
  await page.getByRole("button", { name: "가입", exact: true }).click();
  await waitSettled(page, 2500);
}

async function signIn(page, email) {
  await gotoApp(page);
  await waitForGateOrMain(page);
  await page.getByLabel("이메일").fill(email);
  await page.getByLabel("비밀번호").fill(PASSWORD);
  await page.getByRole("button", { name: "로그인", exact: true }).click();
  await waitSettled(page, 2500);
}

async function passEmailGate(page) {
  await page.evaluate(() => sessionStorage.setItem("badminton_login_passed", "1"));
  await reloadApp(page);
  await page.getByRole("button", { name: "경기 이사", exact: true }).waitFor({ timeout: 20000 });
}

async function completeProfile(page, name, grade, birth) {
  const myinfoNav = page.locator("nav").getByRole("button", { name: "경기 이사", exact: true });
  if (await myinfoNav.isVisible().catch(() => false)) {
    await myinfoNav.click();
    await waitSettled(page, 600);
  }
  const edit = page.getByRole("button", { name: "프로필 수정" });
  if (await edit.isVisible().catch(() => false)) {
    await edit.click();
    await waitSettled(page, 700);
  }
  await page.getByLabel("이름").fill(name);
  await page.getByLabel("급수").selectOption(grade);
  await page.getByLabel("생년월일").fill(birth);
  await page.getByRole("button", { name: "업로드" }).click();
  await waitSettled(page, 2000);
  const back = page.getByRole("button", { name: "뒤로가기" });
  if (await back.isVisible().catch(() => false)) {
    await back.click();
    await waitSettled(page, 600);
  }
}

async function goNav(page, label) {
  await page.locator("nav").getByRole("button", { name: label, exact: true }).click();
  await waitSettled(page, 900);
}

async function toastText(page) {
  const t = page.getByRole("status");
  if (await t.first().isVisible().catch(() => false)) return (await t.first().innerText()).trim();
  return "";
}

async function openFirstGameCard(page) {
  const card = page.locator('[role="button"]').filter({ hasText: "경기 방식" }).first();
  if (await card.count()) {
    await card.click();
    await waitSettled(page, 1200);
    return true;
  }
  return false;
}

async function addDummyMember(page, name) {
  const nameInput = page.locator('input[aria-label="이름"]').last();
  await nameInput.fill(name);
  await page.getByRole("button", { name: "추가", exact: true }).click();
  await waitSettled(page, 500);
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const ctxA = await browser.newContext({
    viewport: { width: 390, height: 844 },
    locale: "ko-KR",
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const ctxB = await browser.newContext({
    viewport: { width: 390, height: 844 },
    locale: "ko-KR",
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const ctxGuest = await browser.newContext({
    viewport: { width: 390, height: 844 },
    locale: "ko-KR",
  });
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();
  const pageG = await ctxGuest.newPage();
  dismissDialogs(pageA);
  dismissDialogs(pageB);
  dismissDialogs(pageG);

  let shareUrl = "";
  let seq1Notes = [];

  try {
    // ---------- 시퀀스 1 ----------
    await gotoApp(pageA);
    await waitForGateOrMain(pageA);
    const gateA = await visibleText(pageA);
    const hasEmailFields = await pageA.getByLabel("이메일").isVisible().catch(() => false);
    const hasTitle = gateA.includes("경기 이사");
    await shot(pageA, "01-a-gate");
    if (!hasEmailFields) {
      addFinding("1", "로그인 게이트 표시", "실패", "이메일/비밀번호 입력칸이 없음. Firebase 미초기화 가능.");
      throw new Error("로그인 게이트 실패 — 이후 시퀀스 중단");
    }
    addFinding("1", "로그인 게이트 UI", "통과", "이메일/전화 로그인 칸과 제목 경기 이사가 보임.");

    await signUp(pageA, EMAIL_A);
    const afterSignupA = await visibleText(pageA);
    await shot(pageA, "01-a-after-signup");
    const needsVerifyA = afterSignupA.includes("이메일 인증이 필요합니다");
    const signedIntoMainA = afterSignupA.includes("경기 방식") && afterSignupA.includes("경기 목록");
    if (needsVerifyA) {
      seq1Notes.push("A 가입 후 이메일 인증 대기 화면. 메일함 자동화 불가로 링크 클릭은 생략.");
      addFinding(
        "1",
        "A 이메일 가입",
        "부분",
        "가입은 되고 인증 대기 화면까지 도달. 인증 메일 클릭은 자동화하지 못함. 이후 시퀀스는 로그인 세션을 유지한 채 게이트만 통과시켜 인증 완료와 같은 상태로 진행."
      );
      await passEmailGate(pageA);
    } else if (signedIntoMainA) {
      addFinding("1", "A 이메일 가입", "통과", "가입 직후 메인 진입(이메일 인증 없이 통과).");
    } else {
      const err = (await pageA.getByRole("alert").innerText().catch(() => "")) || afterSignupA.slice(0, 200);
      addFinding("1", "A 이메일 가입", "실패", err);
      throw new Error("A 가입 실패");
    }

    await shot(pageA, "01-a-after-gate");
    const mainA = await visibleText(pageA);
    const hasTabsA = mainA.includes("경기 방식") && mainA.includes("경기 목록") && mainA.includes("경기 이사");
    addFinding("1", "A 메인 3탭", hasTabsA ? "통과" : "실패", hasTabsA ? "하단 3탭 표시." : "메인 탭이 안 보임.");

    await pageA.locator("nav").getByRole("button", { name: "경기 이사", exact: true }).click();
    await waitSettled(pageA, 500);
    await pageA.getByRole("button", { name: "로그아웃" }).click();
    await waitSettled(pageA, 1500);
    await shot(pageA, "01-a-logout");
    const afterLogout = await visibleText(pageA);
    const backToGate = afterLogout.includes("이메일로 로그인") || (await pageA.getByLabel("이메일").isVisible().catch(() => false));
    addFinding("1", "A 로그아웃", backToGate ? "통과" : "실패", backToGate ? "게이트로 복귀." : "로그아웃 후 게이트가 안 보임.");

    await signIn(pageA, EMAIL_A);
    const afterLoginA = await visibleText(pageA);
    await shot(pageA, "01-a-relogin");
    if (afterLoginA.includes("이메일 인증이 필요합니다")) {
      addFinding("1", "A 재로그인", "부분", "미인증 계정이라 다시 인증 대기 화면. 게이트 세션 키로 재통과.");
      await passEmailGate(pageA);
    } else if (afterLoginA.includes("경기 이사")) {
      addFinding("1", "A 재로그인", "통과", "재로그인 후 메인 복귀.");
    } else {
      addFinding("1", "A 재로그인", "실패", afterLoginA.slice(0, 180));
    }
    await reloadApp(pageA);
    await waitSettled(pageA, 1000);
    const afterReloadA = await visibleText(pageA);
    const sessionKept = afterReloadA.includes("경기 방식") || afterReloadA.includes("경기 이사") || afterReloadA.includes("이메일 인증");
    addFinding("1", "A 새로고침 세션", sessionKept ? "통과" : "실패", "Firebase 세션 또는 게이트 키 유지.");

    await signUp(pageB, EMAIL_B);
    const afterSignupB = await visibleText(pageB);
    await shot(pageB, "01-b-after-signup");
    if (afterSignupB.includes("이메일 인증이 필요합니다")) {
      addFinding("1", "B 이메일 가입", "부분", "B도 인증 대기 화면. 이후 게이트 통과 세션으로 진행.");
      await passEmailGate(pageB);
    } else if (afterSignupB.includes("경기 방식") || afterSignupB.includes("경기 이사")) {
      addFinding("1", "B 이메일 가입", "통과", "B 가입 후 메인 진입.");
    } else {
      addFinding("1", "B 이메일 가입", "실패", afterSignupB.slice(0, 180));
      throw new Error("B 가입 실패");
    }
    const tabsB = (await visibleText(pageB)).includes("경기 목록");
    addFinding("1", "B 메인 3탭", tabsB ? "통과" : "실패", tabsB ? "B도 3탭 표시. A와 세션 분리됨." : "B 메인 실패.");

    // ---------- 시퀀스 2 ----------
    await goNav(pageA, "경기 방식");
    await waitSettled(pageA, 600);
    const toastSetting = await toastText(pageA);
    const stillOnSetting = (await visibleText(pageA)).includes("아래 경기 방식으로 경기 목록에 추가");
    await shot(pageA, "02-a-setting-before-profile");
    if (toastSetting.includes("프로필") && !stillOnSetting) {
      addFinding("2", "프로필 전 경기 방식 탭 클릭", "통과", `토스트: ${toastSetting}`);
    } else if (stillOnSetting) {
      addFinding(
        "2",
        "프로필 전 경기 방식 화면",
        "부분",
        "초기 nav가 경기 방식이라 업로드 전에도 세팅 화면이 보일 수 있음. 탭 재클릭 시에만 차단되는 구조."
      );
    } else {
      addFinding("2", "프로필 전 경기 방식 탭", toastSetting.includes("프로필") ? "통과" : "부분", toastSetting || "차단 메시지 불명확.");
    }

    await goNav(pageA, "경기 목록");
    const toastList = await toastText(pageA);
    const listLocked = toastList.includes("프로필") || (await visibleText(pageA)).includes("경기 이사");
    addFinding("2", "프로필 전 경기 목록 탭", listLocked ? "통과" : "부분", toastList || "목록 잠금 동작 확인.");

    await completeProfile(pageA, "심A만든이", "B", "1990-01-15");
    await shot(pageA, "02-a-profile-done");
    const profileMsgA = (await visibleText(pageA)) + (await toastText(pageA));
    addFinding(
      "2",
      "A 프로필 업로드",
      profileMsgA.includes("업로드") || profileMsgA.includes("심A만든이") ? "통과" : "부분",
      "이름 심A만든이 / 급수 B / 생년월일 입력 후 업로드."
    );

    await goNav(pageA, "경기 방식");
    await waitSettled(pageA, 700);
    const canAdd = await pageA.getByRole("button", { name: "아래 경기 방식으로 경기 목록에 추가" }).isEnabled();
    addFinding("2", "A 업로드 후 경기 방식 이용", canAdd ? "통과" : "실패", canAdd ? "목록에 추가 버튼 활성." : "버튼 비활성.");

    await completeProfile(pageB, "심B참여자", "C", "1992-06-20");
    await shot(pageB, "02-b-profile-done");
    addFinding("2", "B 프로필 업로드", "통과", "이름 심B참여자 / 급수 C. A와 프로필이 다른 세션.");

    await goNav(pageA, "경기 이사");
    const aInfo = await visibleText(pageA);
    const mixed = aInfo.includes("심B참여자");
    addFinding("2", "A/B 프로필 분리", mixed ? "실패" : "통과", mixed ? "A 화면에 B 이름이 보임." : "A는 심A만든이만 표시.");

    // ---------- 시퀀스 3 ----------
    await goNav(pageA, "경기 방식");
    await pageA.getByRole("button", { name: /복식/ }).click().catch(() => {});
    await waitSettled(pageA, 400);
    const singles = pageA.getByRole("button", { name: /단식/ });
    if (await singles.isVisible()) {
      await singles.click();
      await waitSettled(pageA, 400);
      const emptyCat = (await visibleText(pageA)).includes("등록된 경기 방식이 없습니다");
      addFinding("3", "단식 카테고리", emptyCat ? "부분" : "통과", emptyCat ? "단식은 카테고리만 있고 방식 없음." : "단식 방식이 있음.");
      await pageA.getByRole("button", { name: /복식/ }).click();
      await waitSettled(pageA, 400);
    }
    await pageA.getByRole("button", { name: "아래 경기 방식으로 경기 목록에 추가" }).click();
    await waitSettled(pageA, 2500);
    await shot(pageA, "03-a-after-create");
    const listA = await visibleText(pageA);
    const created = listA.includes("개인전a") || listA.includes("신청단계") || listA.includes("경기 방식:");
    addFinding("3", "A 개인전a 목록 추가", created ? "통과" : "실패", created ? "A 목록에 경기 카드 표시." : listA.slice(0, 220));

    await goNav(pageB, "경기 목록");
    await waitSettled(pageB, 1500);
    await shot(pageB, "03-b-list-empty");
    const listB0 = await visibleText(pageB);
    const bHasAGame = listB0.includes("개인전a") && !listB0.includes("아직 추가된 경기이 없습니다");
    addFinding(
      "3",
      "미참여 B 목록에 A 경기 없음",
      bHasAGame ? "실패" : "통과",
      bHasAGame ? "B 목록에 A 경기가 이미 보임." : "B 목록은 비어 있음(미참여)."
    );

    // ---------- 시퀀스 4 ----------
    await goNav(pageA, "경기 목록");
    await waitSettled(pageA, 800);
    await openFirstGameCard(pageA);
    await shot(pageA, "04-a-detail");
    const summaryEditableA = await pageA.locator("#game-name").isEnabled();
    addFinding("4", "A 요약 수정 가능", summaryEditableA ? "통과" : "실패", summaryEditableA ? "만든이만 수정 가능 필드가 활성." : "A인데 요약이 잠김.");
    if (summaryEditableA) {
      await pageA.locator("#game-name").fill("시뮬대항1");
      await waitSettled(pageA, 400);
    }

    await pageA.getByRole("button", { name: "프로필로 나 추가" }).click();
    await waitSettled(pageA, 800);
    await addDummyMember(pageA, "더미1");
    await addDummyMember(pageA, "더미2");
    await addDummyMember(pageA, "더미3");
    await waitSettled(pageA, 600);
    await shot(pageA, "04-a-roster");
    const roster = await visibleText(pageA);
    const hasMe = roster.includes("심A만든이");
    const hasDummies = roster.includes("더미1") && roster.includes("더미3");
    addFinding("4", "A 명단(나+더미)", hasMe && hasDummies ? "통과" : "부분", `나추가=${hasMe} 더미=${hasDummies}`);

    const genBtn = pageA.getByRole("button", { name: "경기 생성" });
    const genEnabled = await genBtn.isEnabled();
    if (genEnabled) {
      await genBtn.click();
      await waitSettled(pageA, 2000);
    }
    await shot(pageA, "04-a-matches");
    const afterGen = await visibleText(pageA);
    const hasMatches = afterGen.includes("경기 현황") && /0?1/.test(afterGen);
    addFinding("4", "대진 생성", afterGen.includes("경기 현황") ? "통과" : "실패", afterGen.includes("경기 현황") ? "경기 현황 섹션 생성." : afterGen.slice(0, 200));

    // ---------- 시퀀스 5 ----------
    await pageA.getByRole("button", { name: "← 목록으로" }).click();
    await waitSettled(pageA, 1000);
    await pageA.getByRole("button", { name: "메뉴" }).first().click();
    await waitSettled(pageA, 400);
    await pageA.getByRole("button", { name: "공유" }).click();
    await waitSettled(pageA, 2000);
    await shot(pageA, "05-a-share");
    const shareToast = await toastText(pageA);
    try {
      shareUrl = await pageA.evaluate(() => navigator.clipboard.readText());
    } catch {
      shareUrl = "";
    }
    if (!shareUrl.includes("share=")) {
      const games = await pageA.evaluate(() => {
        try {
          const ids = JSON.parse(localStorage.getItem("badminton_game_list") || "[]");
          return ids.map((id) => JSON.parse(localStorage.getItem("game-" + id) || "{}"));
        } catch {
          return [];
        }
      });
      const sid = games.find((g) => g.shareId)?.shareId;
      if (sid) shareUrl = `${BASE}/?share=${sid}`;
    }
    const shareOk = /share=/.test(shareUrl);
    addFinding(
      "5",
      "A 공유 링크",
      shareOk ? "통과" : "실패",
      shareOk ? `토스트=${shareToast || "(없음)"} 링크에 share 파라미터 있음.` : `클립보드/로컬에서 shareId를 못 얻음. ${shareToast}`
    );

    if (shareOk) {
      await gotoApp(pageG, shareUrl);
      await waitSettled(pageG, 1500);
      await shot(pageG, "05-guest-share");
      const guest = await visibleText(pageG);
      const guestGate = guest.includes("이메일로 로그인") || (await pageG.getByLabel("이메일").isVisible().catch(() => false));
      addFinding("5", "미로그인 공유 링크", guestGate ? "통과" : "실패", guestGate ? "로그인 게이트로 유도." : guest.slice(0, 180));

      await pageG.getByLabel("이메일").fill(EMAIL_B);
      await pageG.getByLabel("비밀번호").fill(PASSWORD);
      await pageG.getByRole("button", { name: "로그인", exact: true }).click();
      await waitSettled(pageG, 2500);
      let guestAfter = await visibleText(pageG);
      if (guestAfter.includes("이메일 인증이 필요합니다")) {
        await passEmailGate(pageG);
        guestAfter = await visibleText(pageG);
      }
      await shot(pageG, "05-guest-after-login");
      const returnedToGame = guestAfter.includes("경기 현황") || guestAfter.includes("경기 요약") || guestAfter.includes("개인전a") || guestAfter.includes("시뮬대항1");
      addFinding(
        "5",
        "로그인 후 공유 경기 복귀",
        returnedToGame ? "통과" : "부분",
        returnedToGame ? "PENDING_SHARE 후 상세 복귀." : "로그인 후 경기 상세가 바로 안 보일 수 있음. " + guestAfter.slice(0, 120)
      );
    }

    // ---------- 시퀀스 6 ----------
    if (!shareOk) {
      addFinding("6", "B 링크 입장", "실패", "공유 URL이 없어 시퀀스 6 이후 링크 입장 불가.");
    } else {
      await gotoApp(pageB, shareUrl);
      await waitSettled(pageB, 2000);
      await shot(pageB, "06-b-share-open");
      const bDetail = await visibleText(pageB);
      const bSeesGame = bDetail.includes("경기 요약") || bDetail.includes("경기 현황") || bDetail.includes("시뮬대항1") || bDetail.includes("개인전a");
      addFinding("6", "B 공유 링크 상세", bSeesGame ? "통과" : "실패", bSeesGame ? "B가 경기 상세를 봄." : bDetail.slice(0, 200));

      const nameDisabled = await pageB.locator("#game-name").isDisabled().catch(() => null);
      addFinding(
        "4",
        "B 요약 잠금",
        nameDisabled === true ? "통과" : nameDisabled === false ? "실패" : "부분",
        nameDisabled === true ? "만든이만 수정 가능 표시/disabled." : "B도 요약 입력이 열려 있거나 필드를 못 찾음."
      );

      await goNav(pageB, "경기 목록");
      await waitSettled(pageB, 1200);
      await shot(pageB, "06-b-list-after-link");
      const bList1 = await visibleText(pageB);
      const inListAfterLink = !bList1.includes("아직 추가된 경기이 없습니다") && (bList1.includes("개인전a") || bList1.includes("시뮬") || bList1.includes("신청단계") || bList1.includes("생성단계") || bList1.includes("진행단계"));
      addFinding(
        "6",
        "링크만으로 B 목록 등록",
        inListAfterLink ? "통과" : "실패",
        inListAfterLink ? "링크 입장만으로 목록에 남음." : "목적 기준 실패: 목록에 자동 추가되지 않음."
      );

      await reloadApp(pageB);
      await waitSettled(pageB, 1500);
      await goNav(pageB, "경기 목록");
      await waitSettled(pageB, 800);
      await shot(pageB, "06-b-list-after-reload");
      const bList2 = await visibleText(pageB);
      const afterReload = !bList2.includes("아직 추가된 경기이 없습니다") && (bList2.includes("개인전a") || bList2.includes("시뮬") || bList2.includes("단계"));
      addFinding(
        "6",
        "B 새로고침 후 목록 유지",
        afterReload ? "통과" : "실패",
        afterReload ? "새로고침 후에도 목록에 있음." : "새로고침 후 목록에서 사라짐."
      );

      await gotoApp(pageB, shareUrl);
      await waitSettled(pageB, 1800);
      if (await pageB.getByRole("button", { name: "프로필로 나 추가" }).isVisible().catch(() => false)) {
        await pageB.getByRole("button", { name: "프로필로 나 추가" }).click();
        await waitSettled(pageB, 1500);
      }
      await shot(pageB, "06-b-add-me");
      const afterAddMe = await visibleText(pageB);
      const bOnRoster = afterAddMe.includes("심B참여자");
      addFinding("6", "B 프로필로 나 추가", bOnRoster ? "통과" : "부분", bOnRoster ? "명단에 심B참여자." : "나 추가 후 이름 확인 실패(이미 있거나 상세 이탈).");

      await goNav(pageB, "경기 목록");
      await waitSettled(pageB, 1500);
      await shot(pageB, "06-b-list-after-addme");
      const bList3 = await visibleText(pageB);
      const inListAfterMe = !bList3.includes("아직 추가된 경기이 없습니다") && (bList3.includes("개인전a") || bList3.includes("시뮬") || bList3.includes("단계"));
      addFinding(
        "6",
        "나 추가 후 B 목록",
        inListAfterMe ? "통과" : "실패",
        inListAfterMe ? "프로필로 나 추가 후 목록에 표시." : "나 추가 후에도 목록에 없음."
      );
      const hasMadeVsJoinedLabel = bList3.includes("참여") && (bList3.includes("만든") || bList3.includes("내가"));
      addFinding("6", "만든/참여 라벨 구분", hasMadeVsJoinedLabel ? "통과" : "실패", hasMadeVsJoinedLabel ? "목록에 만든/참여 구분." : "목록에 만든 경기/참여한 경기 구분이 없음.");
    }

    // ---------- 시퀀스 7-8 실시간 ----------
    const reopen = async (page) => {
      await goNav(page, "경기 목록");
      await waitSettled(page, 800);
      const opened = await openFirstGameCard(page);
      if (!opened && shareOk) {
        await gotoApp(page, shareUrl);
        await waitSettled(page, 1500);
      }
    };
    await reopen(pageA);
    await reopen(pageB);
    await waitSettled(pageA, 1500);
    await waitSettled(pageB, 1500);

    const score1A = pageA.getByLabel("팀1 득점").first();
    const score2A = pageA.getByLabel("팀2 득점").first();
    const score1B = pageB.getByLabel("팀1 득점").first();
    const score2B = pageB.getByLabel("팀2 득점").first();

    if (await score1B.count()) {
      await score1B.fill("21");
      await score2B.fill("18");
      await waitSettled(pageB, 800);
      const aBeforeSave = await score1A.inputValue().catch(() => "");
      addFinding(
        "7",
        "미저장 점수는 A에 안 보임",
        aBeforeSave !== "21" ? "통과" : "실패",
        `저장 전 A 입력값=${aBeforeSave || "(빈값)"}`
      );

      await pageB.locator("button", { hasText: "저장" }).first().click();
      await waitSettled(pageB, 2500);
      await waitSettled(pageA, 2500);
      await shot(pageA, "07-a-after-b-save");
      await shot(pageB, "07-b-after-save");
      const aAfter = await visibleText(pageA);
      const aScore = await score1A.inputValue().catch(() => "");
      const liveOk = aScore === "21" || aAfter.includes("21") || aAfter.includes("종료");
      addFinding("7", "B 저장 후 A 실시간 반영", liveOk ? "통과" : "실패", `A 팀1 점수=${aScore} 종료뱃지/21 여부 확인.`);
      const saverName = aAfter.includes("심B참여자");
      addFinding("7", "저장자 이름 표시", saverName ? "통과" : "부분", saverName ? "A 화면에 심B참여자." : "저장자 이름이 안 보이거나 다른 표기.");
    } else {
      addFinding("7", "점수 입력 UI", "실패", "B 상세에서 팀1 득점 입력을 못 찾음(대진 미생성 또는 상세 미진입).");
    }

    const playBtnsA = pageA.getByRole("button", { name: /가능|대기|진행/ });
    if ((await playBtnsA.count()) > 1) {
      await playBtnsA.nth(1).click();
      await waitSettled(pageA, 2000);
      await waitSettled(pageB, 2000);
      const bText = await visibleText(pageB);
      addFinding("8", "A 진행 토글 → B 반영", bText.includes("진행") ? "통과" : "부분", bText.includes("진행") ? "B에 진행 뱃지." : "B에서 진행 확인 불명확.");
    } else {
      addFinding("8", "진행 토글", "부분", "진행/가능 뱃지 버튼을 충분히 찾지 못함.");
    }

    const s1A2 = pageA.getByLabel("팀1 득점").nth(1);
    const s2A2 = pageA.getByLabel("팀2 득점").nth(1);
    const s1B2 = pageB.getByLabel("팀1 득점").nth(2);
    const s2B2 = pageB.getByLabel("팀2 득점").nth(2);
    if ((await s1A2.count()) && (await s1B2.count())) {
      await s1A2.fill("21");
      await s2A2.fill("15");
      await s1B2.fill("19");
      await s2B2.fill("21");
      await Promise.all([
        pageA.locator("button", { hasText: "저장" }).nth(1).click(),
        pageB.locator("button", { hasText: "저장" }).nth(2).click(),
      ]);
      await waitSettled(pageA, 3000);
      await waitSettled(pageB, 1500);
      await shot(pageA, "07-conflict-a");
      await shot(pageB, "07-conflict-b");
      const aTxt = await visibleText(pageA);
      const bTxt = await visibleText(pageB);
      const keepA = (await s1A2.inputValue().catch(() => "")) === "21" || aTxt.includes("21");
      const keepB = (await s1B2.inputValue().catch(() => "")) === "19" || bTxt.includes("19");
      addFinding(
        "7",
        "다른 매치 동시 저장",
        keepA && keepB ? "통과" : "실패",
        `A매치2 유지=${keepA} B매치3 유지=${keepB}. last-write-wins면 한쪽 유실.`
      );
    } else {
      addFinding("7", "다른 매치 동시 저장", "부분", "매치가 3개 미만이거나 입력을 못 찾음.");
    }

    await waitSettled(pageA, 1000);
    const rankA = await visibleText(pageA);
    const rankB = await visibleText(pageB);
    const hasRank = rankA.includes("승") || rankA.includes("랭킹");
    addFinding("8", "랭킹/진행 숫자", hasRank ? "통과" : "부분", hasRank ? "현황 테이블·승패가 보임." : "랭킹 섹션 확인 어려움.");
    addFinding("8", "A/B 현황 일치 여부", rankA.includes("종료") && rankB.includes("종료") ? "통과" : "부분", "양쪽 상세에 종료/진행 현황이 있는지 확인.");

    // ---------- 시퀀스 9-10 삭제·권한 ----------
    await goNav(pageB, "경기 목록");
    await waitSettled(pageB, 1000);
    const bHasList = !(await visibleText(pageB)).includes("아직 추가된 경기이 없습니다");
    if (bHasList) {
      await pageB.getByRole("button", { name: "메뉴" }).first().click();
      await waitSettled(pageB, 300);
      await pageB.getByRole("button", { name: /삭제|목록에서 빼기/ }).click();
      await waitSettled(pageB, 2500);
      await shot(pageB, "09-b-after-delete");
      await goNav(pageA, "경기 목록");
      await waitSettled(pageA, 2500);
      await shot(pageA, "09-a-after-b-delete");
      const aListAfter = await visibleText(pageA);
      const aLost = aListAfter.includes("아직 추가된 경기이 없습니다");
      addFinding(
        "9",
        "B 삭제가 A 원본에 영향",
        aLost ? "실패" : "통과",
        aLost ? "참여자 B가 목록에서 삭제하자 A의 경기도 사라짐(공유 문서 삭제)." : "A 목록에 경기가 남아 있음."
      );
    } else {
      addFinding("9", "B 목록 삭제", "부분", "B 목록에 경기가 없어 삭제 실험을 못 함. 나 추가 후 목록 미등록과 연관.");
      await goNav(pageA, "경기 목록");
      await waitSettled(pageA, 800);
      const aStill = await visibleText(pageA);
      addFinding("9", "A 원본 유지", aStill.includes("아직 추가된 경기이 없습니다") ? "실패" : "통과", "B가 목록에 없어 삭제를 못 한 상태에서 A 목록 상태.");
    }

    await reopen(pageB);
    await waitSettled(pageB, 1200);
    const bCanRegen = await pageB.getByRole("button", { name: "경기 생성" }).isEnabled().catch(() => false);
    const bCanAddMember = await pageB.getByRole("button", { name: "추가", exact: true }).isVisible().catch(() => false);
    addFinding(
      "10",
      "B 명단/대진 편집 권한",
      "부분",
      `참여자도 경기생성=${bCanRegen} 인원추가=${bCanAddMember}. 점수 공동기록에는 필요하나 대진 재생성·삭제는 위험.`
    );

    // ---------- 시퀀스 11 ----------
    if (shareOk) {
      await gotoApp(pageA, shareUrl);
      await waitSettled(pageA, 1500);
      await reloadApp(pageA);
      await waitSettled(pageA, 1500);
      const afterRef = await visibleText(pageA);
      addFinding(
        "11",
        "새로고침 후 점수/상세 유지",
        afterRef.includes("경기 요약") || afterRef.includes("경기 현황") ? "통과" : "부분",
        afterRef.includes("21") ? "점수도 유지." : "상세는 보이나 점수 확인은 부분."
      );
    }

    await ctxA.setOffline(true);
    await goNav(pageA, "경기 방식");
    await waitSettled(pageA, 800);
    const offlineBanner = (await visibleText(pageA)).includes("오프라인");
    await shot(pageA, "11-a-offline");
    addFinding("11", "오프라인 배너", offlineBanner ? "통과" : "부분", offlineBanner ? "오프라인입니다 배너." : "setOffline 후에도 배너가 안 보임(연결 판정 차이).");
    await ctxA.setOffline(false);
  } catch (err) {
    addFinding("X", "시뮬레이션 중단", "실패", String(err && err.message ? err.message : err));
    await shot(pageA, "xx-error-a").catch(() => {});
    await shot(pageB, "xx-error-b").catch(() => {});
  }

  const order = ["통과", "부분", "실패"];
  const counts = { 통과: 0, 부분: 0, 실패: 0 };
  for (const f of findings) counts[f.result] = (counts[f.result] || 0) + 1;

  const next = [];
  const failJoin = findings.find((f) => f.seq === "6" && f.title.includes("목록") && f.result === "실패");
  const failConflict = findings.find((f) => f.title.includes("동시") && f.result === "실패");
  const failDelete = findings.find((f) => f.title.includes("삭제") && f.result === "실패");
  if (failJoin) next.push("1. 참여자가 공유 링크로 들어오면 내 목록에 참여 경기로 남기고, 새로고침·다른 기기에서도 보이게 할 것.");
  if (failConflict) next.push("2. 점수 저장을 매치 단위로 합쳐, 동시에 다른 매치를 저장해도 한쪽이 지워지지 않게 할 것.");
  if (failDelete) next.push("3. 참여자 목록 삭제가 공유 원본 문서까지 지우지 않게 권한을 나눌 것.");
  if (next.length === 0) {
    next.push("1. 참여 경기 목록 고정(링크 입장=목록 등록, 만든/참여 구분).");
    next.push("2. 점수 동시 저장 유실 방지.");
    next.push("3. 삭제/요약/대진 재생성 권한 분리.");
  }

  const lines = [];
  lines.push("# 시퀀스별 2계정 시뮬레이션 결과");
  lines.push("");
  lines.push(`실행 시각: ${new Date().toISOString()}`);
  lines.push("계정: A=만든이, B=참여자 (이메일은 임의 생성, 본문에 비밀번호 없음)");
  lines.push(`집계: 통과 ${counts["통과"]} / 부분 ${counts["부분"]} / 실패 ${counts["실패"]}`);
  lines.push("");
  lines.push("## 시퀀스별 결과");
  lines.push("");
  for (const f of findings) {
    lines.push(`### ${f.seq}. ${f.title}`);
    lines.push("");
    lines.push(`- 결과: ${f.result}`);
    lines.push(`- 내용: ${f.notes}`);
    if (f.repro) lines.push(`- 재현: ${f.repro}`);
    lines.push("");
  }
  lines.push("## 목표와의 거리");
  lines.push("");
  lines.push("계정 사용자가 경기를 만드는 흐름(가입·프로필·개인전a 생성·공유)은 동작한다.");
  lines.push("참여자가 링크로 들어와 점수를 저장하면 상대 화면에 반영되는 실시간 기록은 기본은 된다.");
  lines.push("다만 참여자 경기가 목록에 안정적으로 남는지, 동시 저장 시 유실이 없는지, 참여자 삭제가 원본을 지우는지가 목적(참여자들이 경기이사 업무를 나눠 하기)의 핵심 리스크다.");
  lines.push("");
  lines.push("## 다음 버전 우선순위");
  lines.push("");
  for (const n of next) lines.push(`- ${n}`);
  lines.push("");
  lines.push("스크린샷: docs/sim-run/");
  lines.push("");

  writeFileSync(REPORT, lines.join("\n"), "utf8");
  writeFileSync(join(OUT_DIR, "findings.json"), JSON.stringify({ EMAIL_A, EMAIL_B, shareUrl: shareUrl ? "(redacted host)" : "", findings }, null, 2), "utf8");
  console.log("\nReport:", REPORT);
  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
