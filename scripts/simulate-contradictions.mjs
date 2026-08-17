/**
 * A(만든이)·B(참여자) 상태기계 시뮬레이션.
 * 앱의 join/merge/점수잠금 규칙을 그대로 돌려 안내와 동작이 어긋나는 지점을 찾는다.
 */
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "docs", "sim-run");

function isRecordedScore(m) {
  return m.score1 != null && m.score2 != null && (m.score1 !== 0 || m.score2 !== 0);
}
function gameHasRecordedScore(matches) {
  return (matches ?? []).some(isRecordedScore);
}
function rosterOutOfSyncWithDraw(members, matches) {
  if (!matches?.length) return false;
  const inDraw = new Set();
  for (const match of matches) {
    for (const p of match.team1.players) inDraw.add(p.id);
    for (const p of match.team2.players) inDraw.add(p.id);
  }
  return members.some((m) => !inDraw.has(m.id));
}
function resolveMyProfileMemberId(members, uid, name) {
  if (uid) {
    const linked = members.find((m) => m.linkedUid === uid);
    if (linked) return linked.id;
  }
  const trimmed = name?.trim();
  if (!trimmed) return null;
  const byName = members.find((m) => m.name === trimmed && (!m.linkedUid || m.linkedUid === uid));
  return byName?.id ?? null;
}
function applyMyProfileToMembers(members, myProfileMemberId, myInfo) {
  if (!myProfileMemberId) return members;
  return members.map((m) => {
    if (m.id !== myProfileMemberId) return m;
    if (m.linkedUid && myInfo.uid && m.linkedUid !== myInfo.uid) return m;
    return { ...m, name: myInfo.name ?? m.name };
  });
}
function joinSelfToGameData(data, profile) {
  const uid = profile.uid;
  const name = profile.name?.trim() ?? "";
  if (!uid || !name) return data;
  const members = data.members ?? [];
  const existing = members.find((m) => m.linkedUid === uid);
  if (existing) return { ...data, myProfileMemberId: existing.id };
  if (gameHasRecordedScore(data.matches)) return data;
  if (members.length >= (profile.maxPlayers ?? 12)) return data;
  const newId = `b-${members.length + 1}`;
  return {
    ...data,
    members: [...members, { id: newId, name, linkedUid: uid, wins: 0, losses: 0, pointDiff: 0 }],
    myProfileMemberId: newId,
  };
}
function mergeMembers(remote, local, isOwner, editorUid) {
  if (isOwner) {
    const remoteById = new Map(remote.map((m) => [m.id, m]));
    const localLinked = new Set(local.map((m) => m.linkedUid).filter(Boolean));
    const merged = local.map((lm) => {
      const rm = remoteById.get(lm.id);
      return rm ? { ...rm, ...lm, linkedUid: lm.linkedUid ?? rm.linkedUid } : lm;
    });
    const localIds = new Set(merged.map((m) => m.id));
    for (const rm of remote) {
      if (rm.linkedUid && !localLinked.has(rm.linkedUid) && !localIds.has(rm.id)) {
        merged.push(rm);
        localIds.add(rm.id);
      }
    }
    return merged;
  }
  const result = [...remote];
  if (!editorUid) return result;
  const localSelf = local.filter((m) => m.linkedUid === editorUid);
  if (localSelf.length === 0) return result.filter((m) => m.linkedUid !== editorUid);
  for (const self of localSelf) {
    const idx = result.findIndex((m) => m.id === self.id || m.linkedUid === editorUid);
    if (idx >= 0) result[idx] = { ...result[idx], ...self, linkedUid: editorUid };
    else if (!result.some((m) => m.linkedUid === editorUid)) result.push(self);
  }
  return result;
}
function mergeGameData(remote, local, editorUid) {
  const ownerUid = remote.createdByUid ?? local.createdByUid;
  const isOwner = Boolean(editorUid && ownerUid && editorUid === ownerUid);
  const matches = local.matches?.length ? local.matches : remote.matches;
  const freezeRoster = gameHasRecordedScore(remote.matches) || gameHasRecordedScore(local.matches);
  const membersBase = freezeRoster
    ? (remote.members ?? [])
    : mergeMembers(remote.members ?? [], local.members ?? [], isOwner, editorUid);
  return { ...remote, members: membersBase, matches, createdByUid: ownerUid };
}
function canRecordScores(uid, members, matches) {
  return members.some((m) => m.linkedUid === uid) && !rosterOutOfSyncWithDraw(members, matches);
}
function canRegenerate(isOwner, hasSavedScore, matches, members, rosterChangedSinceGenerate) {
  const rosterOutOfSync = rosterOutOfSyncWithDraw(members, matches);
  if (!isOwner) return false;
  if (hasSavedScore) return false;
  if (matches.length > 0 && !rosterChangedSinceGenerate && !rosterOutOfSync) return false;
  return true;
}
function uniqueDrawPlayerCount(matches) {
  const ids = new Set();
  for (const match of matches ?? []) {
    for (const p of match.team1.players) if (p?.id) ids.add(p.id);
    for (const p of match.team2.players) if (p?.id) ids.add(p.id);
  }
  return ids.size;
}
function listLabel(uid, createdByUid, members) {
  if (uid === createdByUid) return "내가 만든 경기";
  if (members.some((m) => m.linkedUid === uid)) return "참여한 경기";
  return "보기만";
}
function shareCopiedMessage(data) {
  if (gameHasRecordedScore(data.matches)) return "목록에 넣고 볼 수 있습니다";
  if ((data.matches ?? []).length > 0) return "명단에 들어가고, 대진에 넣으려면 만든이가 대진을 다시 만들어야 합니다";
  return "명단과 목록에 들어갑니다";
}
function unlink(members, uid, recorded) {
  return recorded
    ? members.map((m) => (m.linkedUid === uid ? { ...m, linkedUid: undefined } : m))
    : members.filter((m) => m.linkedUid !== uid);
}

function person(id, name, uid) {
  return { id, name, linkedUid: uid, wins: 0, losses: 0, pointDiff: 0 };
}
function match(id, a, b, c, d, s1, s2) {
  return {
    id,
    team1: { players: [a, b] },
    team2: { players: [c, d] },
    score1: s1,
    score2: s2,
  };
}

const findings = [];
function add(name, result, value) {
  findings.push({ name, result, value });
  console.log(`${result}\t${name}\t${value}`);
}

function main() {
  const A = "uid-a";
  const B = "uid-b";
  const a = person("a", "심A만든이", A);
  const d1 = person("d1", "더미1", null);
  const d2 = person("d2", "더미2", null);
  const d3 = person("d3", "더미3", null);
  const m1 = match("m1", a, d1, d2, d3);

  // 1. 대진 전 링크
  let beforeDraw = { createdByUid: A, members: [a], matches: [] };
  const joinedBefore = joinSelfToGameData(beforeDraw, { uid: B, name: "심B참여자" });
  add(
    "대진 전 링크 → 명단 추가",
    joinedBefore.members.some((m) => m.linkedUid === B) ? "통과" : "실패",
    `명단 ${joinedBefore.members.length}명`
  );

  // 2. 대진 후 점수 전 링크
  let afterDraw = { createdByUid: A, members: [a, d1, d2, d3], matches: [m1] };
  const joinedAfterDraw = joinSelfToGameData(afterDraw, { uid: B, name: "심B참여자" });
  const bMember = joinedAfterDraw.members.find((m) => m.linkedUid === B);
  const outOfSync = rosterOutOfSyncWithDraw(joinedAfterDraw.members, joinedAfterDraw.matches);
  const regenOn = canRegenerate(true, false, joinedAfterDraw.matches, joinedAfterDraw.members, false);
  add(
    "대진 후 링크 → 명단만 추가",
    bMember && outOfSync && !joinedAfterDraw.matches.some((m) => [...m.team1.players, ...m.team2.players].some((p) => p.id === bMember.id))
      ? "통과"
      : "실패",
    `명단 ${joinedAfterDraw.members.length}명, 대진불일치=${outOfSync}`
  );
  add(
    "대진 후 합류 시 만든이 대진 다시 만들기",
    regenOn ? "통과" : "실패",
    regenOn ? "켜짐" : "꺼짐"
  );

  // 3. 핵심: 대진 후 합류한 B가 점수를 저장하면 대진이 잠김
  const bCanScoreAfterDraw = canRecordScores(B, joinedAfterDraw.members, joinedAfterDraw.matches);
  add(
    "대진 후 합류 B의 점수 저장",
    !bCanScoreAfterDraw ? "통과" : "실패",
    `B점수가능=${bCanScoreAfterDraw}. 대진과 명단이 다르면 점수를 막음`
  );

  // 4. 점수 후 링크
  const afterScore = { createdByUid: A, members: [a, d1, d2, d3], matches: [{ ...m1, score1: 21, score2: 19 }] };
  const joinedAfterScore = joinSelfToGameData(afterScore, { uid: B, name: "심B참여자" });
  const bOnRosterAfterScore = joinedAfterScore.members.some((m) => m.linkedUid === B);
  const bCanScoreAfterLock = canRecordScores(B, joinedAfterScore.members, joinedAfterScore.matches);
  add(
    "점수 후 링크 → 명단 거부",
    !bOnRosterAfterScore && !bCanScoreAfterLock ? "통과" : "실패",
    `명단추가=${bOnRosterAfterScore} 점수가능=${bCanScoreAfterLock}`
  );
  add(
    "점수 후 목록 라벨",
    listLabel(B, A, joinedAfterScore.members) === "보기만" ? "통과" : "실패",
    `라벨=${listLabel(B, A, joinedAfterScore.members)}`
  );
  add(
    "점수 후 공유 안내",
    shareCopiedMessage(afterScore).includes("볼 수 있습니다") ? "통과" : "실패",
    shareCopiedMessage(afterScore)
  );

  // 5. 정원 초과
  const full = { createdByUid: A, members: Array.from({ length: 12 }, (_, i) => person(`p${i}`, `P${i}`, i === 0 ? A : null)), matches: [] };
  const joinedFull = joinSelfToGameData(full, { uid: B, name: "심B참여자", maxPlayers: 12 });
  add(
    "정원 12 초과 링크",
    !joinedFull.members.some((m) => m.linkedUid === B) ? "통과" : "실패",
    `명단 ${joinedFull.members.length}명`
  );

  // 6. 빈칸·0-0은 기록이 아님
  const empty = { matches: [{ ...m1, score1: null, score2: null }] };
  const zero = { matches: [{ ...m1, score1: 0, score2: 0 }] };
  add("빈 점수 잠금", !gameHasRecordedScore(empty.matches) ? "통과" : "실패", "빈칸은 기록 아님");
  add("0-0 잠금", !gameHasRecordedScore(zero.matches) ? "통과" : "실패", "0-0은 기록 아님");
  const uiDoneZero = isRecordedScore(zero.matches[0]);
  add(
    "0-0 화면 종료 표시",
    !uiDoneZero ? "통과" : "실패",
    `화면종료=${uiDoneZero} 기록점수=${gameHasRecordedScore(zero.matches)}`
  );

  // 7. 만든이도 명단에 있어야 점수
  const ownerOffRoster = { members: [d1, d2, d3], matches: [m1] };
  add(
    "만든이 명단 없이 점수",
    !canRecordScores(A, ownerOffRoster.members, ownerOffRoster.matches) ? "통과" : "실패",
    `A점수가능=${canRecordScores(A, ownerOffRoster.members, ownerOffRoster.matches)}`
  );

  // 8. 점수 후 프로필이 남의 칸을 덮지 않음
  const wrongId = applyMyProfileToMembers(
    afterScore.members,
    "a",
    { name: "심B참여자", uid: B }
  );
  add(
    "점수 후 B 프로필이 A 이름 덮음",
    wrongId.find((m) => m.id === "a").name === "심A만든이" ? "통과" : "실패",
    `A이름=${wrongId.find((m) => m.id === "a").name}`
  );
  const resolved = resolveMyProfileMemberId(afterScore.members, B, "심B참여자");
  add(
    "공유문서 myProfileMemberId를 내 칸으로 오인",
    resolved == null ? "통과" : "실패",
    `B의 칸=${resolved}`
  );

  // 9. 점수 후 merge가 B를 명단에 붙이지 않음
  const bLocal = joinSelfToGameData(afterScore, { uid: B, name: "심B참여자" });
  const bTriedAdd = {
    ...afterScore,
    members: [...afterScore.members, person("sneak", "심B참여자", B)],
  };
  const mergedFrozen = mergeGameData(afterScore, bTriedAdd, B);
  add(
    "점수 후 동기화가 B를 명단에 붙임",
    !mergedFrozen.members.some((m) => m.linkedUid === B) ? "통과" : "실패",
    `명단연동B=${mergedFrozen.members.some((m) => m.linkedUid === B)}`
  );

  // 10. 탈퇴 연동 해제
  const withB = { members: [...afterScore.members, person("b", "심B참여자", B)], matches: afterScore.matches };
  const unlinked = unlink(withB.members, B, true);
  add(
    "점수 후 탈퇴 linkedUid",
    unlinked.some((m) => m.id === "b" && !m.linkedUid) && !unlinked.some((m) => m.linkedUid === B) ? "통과" : "실패",
    `이름칸유지=${unlinked.some((m) => m.id === "b")} 연동=${unlinked.some((m) => m.linkedUid === B)}`
  );
  const unlinkedNoScore = unlink(joinedAfterDraw.members, B, false);
  add(
    "점수 전 탈퇴 명단 제거",
    !unlinkedNoScore.some((m) => m.linkedUid === B) ? "통과" : "실패",
    `남은B=${unlinkedNoScore.some((m) => m.linkedUid === B)}`
  );

  // 11. 대진 후 합류 업로드: 만든이 화면에 B가 붙음
  const ownerRemote = mergeGameData(afterDraw, joinedAfterDraw, A);
  add(
    "대진 후 B 업로드 → 만든이 명단",
    ownerRemote.members.some((m) => m.linkedUid === B) ? "통과" : "실패",
    `만든이명단B=${ownerRemote.members.some((m) => m.linkedUid === B)}`
  );

  const listCount = uniqueDrawPlayerCount(joinedAfterDraw.matches);
  const drawCount = new Set(joinedAfterDraw.matches.flatMap((m) => [...m.team1.players, ...m.team2.players].map((p) => p.id))).size;
  add(
    "목록 인원 숫자 vs 대진 인원",
    listCount === drawCount ? "통과" : "실패",
    `카드인원=${listCount} 대진인원=${drawCount}`
  );

  add(
    "도움말(대진 후 다시 만들기) vs B 점수권",
    !bCanScoreAfterDraw ? "통과" : "실패",
    `B점수가능=${bCanScoreAfterDraw}`
  );

  const docs = readFileSync(join(ROOT, "docs", "README.md"), "utf8");
  const readme = readFileSync(join(ROOT, "README.md"), "utf8");
  const docText = docs + "\n" + readme;
  add(
    "문서: 이메일 로그인",
    /이메일\/전화|이메일 또는 전화|이메일\/비밀번호|이메일\/전화번호 로그인/.test(docText) ? "실패" : "통과",
    "입장은 전화만"
  );
  add(
    "문서: 공유 링크는 목록에 안 넣음",
    docs.includes("목록에 자동 추가되지") ? "실패" : "통과",
    "링크는 목록에 넣음"
  );
  add(
    "문서: 공유는 보기만",
    docs.includes("링크만으로는 받는 쪽 경기 목록에 추가되지") ? "실패" : "통과",
    "점수 전에는 명단 참여, 점수 후면 보기만"
  );

  const page = readFileSync(join(ROOT, "app", "page.tsx"), "utf8");
  add(
    "참여자 명단 안내(대진 후 생략)",
    page.includes("대진 전에 링크를 열면 명단에 들어갑니다. 점수가 있으면 보기만 됩니다.") ? "모순" : "통과",
    "참여자 화면은 대진 후 합류를 안내하지 않음"
  );

  const counts = { 통과: 0, 모순: 0, 실패: 0 };
  for (const f of findings) counts[f.result] = (counts[f.result] || 0) + 1;

  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "contradiction-findings.json"), JSON.stringify({ counts, findings }, null, 2), "utf8");
  console.log(`\n집계\t통과 ${counts["통과"]} / 모순 ${counts["모순"]} / 실패 ${counts["실패"]}`);
}

main();
