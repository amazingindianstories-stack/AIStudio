"use client";

export default function ErrorPage({ error, reset }) {
  return (
    <div className="flex min-h-full items-center justify-center bg-ink-900 p-4">
      <div className="w-full max-w-sm rounded-2xl border border-line bg-ink-850 p-7 text-center shadow-pop">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/logo.png" alt="Veevee.ai" className="mx-auto mb-4 h-9 w-9 rounded-lg shadow-sm" />
        <h1 className="text-lg font-semibold text-white">Something went wrong</h1>
        <p role="alert" className="mt-3 rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-200">
          {error?.message || "An unexpected error occurred."}
        </p>
        <button
          type="button"
          onClick={() => reset()}
          className="mt-5 flex w-full items-center justify-center rounded-lg bg-white py-2.5 text-sm font-semibold text-ink-900 shadow-sm transition hover:bg-white/90"
        >
          Try again
        </button>
      </div>
    </div>
  );
}
