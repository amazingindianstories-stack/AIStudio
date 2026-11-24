import Link from "next/link";

export const metadata = { title: "Not found - Veevee.ai" };

export default function NotFound() {
  return (
    <div className="flex min-h-full items-center justify-center bg-ink-900 p-4">
      <div className="w-full max-w-sm rounded-2xl border border-line bg-ink-850 p-7 text-center shadow-pop">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/logo.png" alt="Veevee.ai" className="mx-auto mb-4 h-9 w-9 rounded-lg shadow-sm" />
        <h1 className="text-lg font-semibold text-white">This page does not exist</h1>
        <p className="mt-1 text-sm text-muted">The link may be mistyped or out of date.</p>
        <Link
          href="/"
          className="mt-5 flex w-full items-center justify-center rounded-lg bg-white py-2.5 text-sm font-semibold text-ink-900 shadow-sm transition hover:bg-white/90"
        >
          Back to Veevee
        </Link>
      </div>
    </div>
  );
}
