/**
 * UX 시뮬: 글씨·비율·넘침·터치·탭 액션.
 * 산출: docs/sim-run/ux-report.json, png
 */
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const OUT = join(ROOT, "docs", "sim-run");
const BASE = process.env.SIM_BASE_URL || "http://localhost:3000";
const WIDTHS = [360, 390, 414];
const HEIGHT = 844;

function screenName(text) {
  if (text.includes("전화번호로 본인 확인") || text.includes("인증문자")) return "전화확인";
  if (text.includes("이름과 생년월일")) return "프로필입력";
  if (text.includes("오늘 경기") || text.includes("경기 만들기") || text.includes("사람 모으는 중")) return "오늘";
  if (text.includes("새 경기") && text.includes("경기 만들기")) return "새경기";
  if (text.includes("내 정보") || text.includes("나의 프로필")) return "내정보";
  if (text.includes("로딩 중")) return "로딩";
  return "기타";
}

async function measure(page) {
  return page.evaluate(() => {
    const htmlSize = parseFloat(getComputedStyle(document.documentElement).fontSize);
    const overflowX = document.documentElement.scrollWidth > document.documentElement.clientWidth + 2;
    const buttons = [...document.querySelectorAll("button, [role='button']")]
      .map((el) => {
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        const bg = cs.backgroundColor;
        const isBlue =
          bg.includes("0, 113, 227") ||
          bg.includes("0, 119, 237") ||
          bg.includes("13, 113, 227");
        return {
          text: (el.innerText || el.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim().slice(0, 48),
          w: Math.round(r.width),
          h: Math.round(r.height),
          font: Math.round(parseFloat(cs.fontSize) * 10) / 10,
          isBlue,
          visible: r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none" && r.bottom > 0 && r.top < window.innerHeight,
        };
      })
      .filter((b) => b.visible && b.text);
    const smallTap = buttons.filter((b) => b.h < 44).map((b) => `${b.text}(${b.h}px)`);
    const smallFontBlue = buttons.filter((b) => b.isBlue && b.font < 16).map((b) => `${b.text}(${b.font}px)`);
    const blueOnScreen = buttons.filter((b) => b.isBlue).map((b) => b.text);
    return {
      htmlSize: Math.round(htmlSize * 10) / 10,
      overflowX,
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      smallTap,
      smallFontBlue,
      blueOnScreen,
      buttonCount: buttons.length,
    };
  });
}

async function bodyText(page) {
  return page.locator("body").innerText();
}

async function clickIfVisible(page, name) {
  const exact = typeof name === "string";
  const btn = page.getByRole("button", { name, exact }).first();
  if (await btn.isVisible().catch(() => false)) {
    await btn.click({ timeout: 4000 }).catch(() => {});
    await page.waitForTimeout(600);
    return true;
  }
  return false;
}

async function runWidth(browser, width) {
  const page = await browser.newPage({
    viewport: { width, height: HEIGHT },
    isMobile: true,
    hasTouch: true,
  });
  const steps = [];
  const shot = async (name) => {
    mkdirSync(OUT, { recursive: true });
    await page.screenshot({ path: join(OUT, `ux-${width}-${name}.png`), fullPage: true });
  };

  await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(1500);

  const t0 = await bodyText(page);
  const screen0 = screenName(t0);
  const m0 = await measure(page);
  await shot("01-open");
  steps.push({ 단계: "열기", 화면: screen0, 측정: m0 });

  const loggedIn = screen0 === "오늘" || screen0 === "새경기" || screen0 === "내정보";
  const session = loggedIn ? "있음" : screen0 === "전화확인" || screen0 === "프로필입력" ? "없음" : "불명";

  if (loggedIn) {
    const today = await clickIfVisible(page, "오늘");
    await page.waitForTimeout(400);
    const tToday = await bodyText(page);
    const mToday = await measure(page);
    await shot("02-today");
    steps.push({ 단계: "오늘탭", 클릭: today, 화면: screenName(tToday), 측정: mToday });

    const join = await clickIfVisible(page, "링크로 들어가기");
    if (join) {
      const mJoin = await measure(page);
      await shot("03-join");
      steps.push({ 단계: "링크로들어가기", 클릭: true, 측정: mJoin });
    }

    const make = await clickIfVisible(page, "경기 만들기");
    const tSetting = await bodyText(page);
    const mSetting = await measure(page);
    await shot("04-setting");
    steps.push({ 단계: "새경기또는만들기", 클릭: make, 화면: screenName(tSetting), 측정: mSetting });

    const newGameTab = await clickIfVisible(page, "새 경기");
    if (newGameTab) {
      const mNew = await measure(page);
      await shot("05-newgame-tab");
      steps.push({ 단계: "새경기탭", 클릭: true, 측정: mNew });
    }

    const info = await clickIfVisible(page, "내 정보");
    const tInfo = await bodyText(page);
    const mInfo = await measure(page);
    await shot("06-myinfo");
    steps.push({ 단계: "내정보탭", 클릭: info, 화면: screenName(tInfo), 측정: mInfo });

    await clickIfVisible(page, "오늘");
    await page.waitForTimeout(400);
    const card = page.locator('[role="button"]').filter({ hasText: /사람 모으는 중|대진 있음|점수 적는 중|끝|대진 다시 필요/ }).first();
    const hasCard = await card.isVisible().catch(() => false);
    if (hasCard) {
      await card.click().catch(() => {});
      await page.waitForTimeout(800);
      const tDetail = await bodyText(page);
      const mPeople = await measure(page);
      await shot("07-people");
      steps.push({ 단계: "상세열기", 화면: tDetail.includes("사람") ? "사람" : "상세", 측정: mPeople });

      const people = await clickIfVisible(page, /사람/);
      const draw = await clickIfVisible(page, /대진/);
      const mDraw = await measure(page);
      await shot("08-draw");
      steps.push({ 단계: "대진탭", 클릭: draw, 측정: mDraw });

      const score = await clickIfVisible(page, /점수/);
      const mScore = await measure(page);
      await shot("09-score");
      steps.push({ 단계: "점수탭", 클릭: score, 측정: mScore });

      await clickIfVisible(page, "사람");
      const share = await clickIfVisible(page, "카톡으로 보내기");
      steps.push({ 단계: "카톡으로보내기", 클릭: share });

      await clickIfVisible(page, "목록으로").catch(() => {});
      const back = page.getByRole("button", { name: /목록으로/ });
      if (await back.isVisible().catch(() => false)) {
        await back.click().catch(() => {});
        await page.waitForTimeout(500);
      }
    } else {
      steps.push({ 단계: "상세열기", 클릭: false, 이유: "경기카드없음" });
    }
  } else {
    const send = await clickIfVisible(page, /인증문자/);
    const tSend = await bodyText(page);
    const mSend = await measure(page);
    await shot("02-send-code");
    steps.push({ 단계: "인증문자보내기", 클릭: send, 화면글: tSend.slice(0, 120), 측정: mSend });
  }

  await page.close();
  return { 폭: width, 세션: session, 시작화면: screen0, 단계: steps };
}

const report = {
  대상: BASE,
  시각: new Date().toISOString(),
  폭별: [],
};

const browser = await chromium.launch({ headless: true });
try {
  for (const w of WIDTHS) {
    console.log("width", w);
    report.폭별.push(await runWidth(browser, w));
  }
} finally {
  await browser.close();
}

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "ux-report.json"), JSON.stringify(report, null, 2), "utf8");
console.log(JSON.stringify(report, null, 2));
