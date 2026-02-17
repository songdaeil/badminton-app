"use client";

import { useParams } from "next/navigation";
import { GameView } from "@/app/page";

export default function GamePage() {
  const params = useParams();
  const id = params?.id as string | undefined;

  if (!id) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center px-4">
        <p className="text-slate-600">경기를 찾을 수 없습니다.</p>
      </div>
    );
  }

  return <GameView gameId={id} />;
}
