"use client";

import { useState } from "react";
import type { Grade } from "@/app/types";

const MAX_MEMBERS_DEFAULT = 12;

export function AddMemberForm({
  onAdd,
  primaryColor,
  membersCount = 0,
  maxMembers = MAX_MEMBERS_DEFAULT,
}: {
  onAdd: (name: string, gender: "M" | "F", grade: Grade) => void;
  primaryColor: string;
  membersCount?: number;
  maxMembers?: number;
}) {
  const [name, setName] = useState("");
  const [gender, setGender] = useState<"M" | "F">("M");
  const [grade, setGrade] = useState<Grade>("B");
  const atLimit = membersCount >= maxMembers;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (atLimit) return;
    onAdd(name, gender, grade);
    setName("");
  };

  return (
    <form onSubmit={handleSubmit} className="flex flex-wrap items-end gap-1.5">
      <div className="flex-1 min-w-0">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="이름"
          aria-label="이름"
          className="w-full px-2 py-1.5 rounded-xl border border-[#d2d2d7] bg-[#fbfbfd] text-[#1d1d1f] placeholder:text-[#6e6e73] text-sm focus:outline-none focus:ring-2 focus:ring-[#0071e3]/25 focus:border-[#0071e3]"
        />
      </div>
      <select
        value={gender}
        onChange={(e) => setGender(e.target.value as "M" | "F")}
        aria-label="성별"
        className="shrink-0 w-14 px-1.5 py-1.5 rounded-xl border border-[#d2d2d7] bg-[#fbfbfd] text-[#1d1d1f] text-sm focus:outline-none focus:ring-2 focus:ring-[#0071e3]/25 focus:border-[#0071e3]"
      >
        <option value="M">남</option>
        <option value="F">여</option>
      </select>
      <select
        value={grade}
        onChange={(e) => setGrade(e.target.value as Grade)}
        aria-label="급수"
        className="shrink-0 w-12 px-1.5 py-1.5 rounded-xl border border-[#d2d2d7] bg-[#fbfbfd] text-[#1d1d1f] text-sm focus:outline-none focus:ring-2 focus:ring-[#0071e3]/25 focus:border-[#0071e3]"
      >
        <option value="A">A</option>
        <option value="B">B</option>
        <option value="C">C</option>
        <option value="D">D</option>
      </select>
      <button
        type="submit"
        disabled={atLimit}
        className="shrink-0 py-1.5 px-3 rounded-lg font-medium text-white text-sm hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
        style={{ backgroundColor: primaryColor }}
      >
        추가
      </button>
      {atLimit && <p className="w-full text-xs text-slate-400">경기 인원은 최대 {maxMembers}명까지입니다.</p>}
    </form>
  );
}

export const MAX_MEMBERS = MAX_MEMBERS_DEFAULT;
