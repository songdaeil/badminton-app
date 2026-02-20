"use client";

interface ShareToastProps {
  message: string | null;
}

export function ShareToast({ message }: ShareToastProps) {
  if (!message) return null;
  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40 px-4 py-2 rounded-lg bg-slate-800 text-white text-sm shadow-lg animate-scale-in" role="status">
      {message}
    </div>
  );
}
