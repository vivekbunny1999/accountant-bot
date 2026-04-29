import Link from "next/link";

const steps = ["Connect accounts", "Set basics", "Get your plan"];
const decisions = ["Pause spending", "Pay the right debt", "Protect what matters"];

export default function Home() {
  return (
    <main className="min-h-screen overflow-hidden bg-[#0B0F14] text-zinc-100">
      <section className="mx-auto flex min-h-[82vh] w-full max-w-7xl flex-col items-center justify-center px-6 py-24 text-center sm:px-8">
        <div className="mb-8 rounded-full border border-emerald-300/20 bg-emerald-300/10 px-4 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-emerald-200">
          Accountant Bot
        </div>
        <h1 className="max-w-5xl text-5xl font-bold leading-[1.02] tracking-normal text-white sm:text-6xl lg:text-7xl">
          Stop guessing what to do with your money.
        </h1>
        <p className="mt-8 max-w-2xl text-xl leading-8 text-zinc-300 sm:text-2xl">
          Your Financial OS tells you exactly what to do next.
        </p>
        <Link
          href="/signup"
          className="mt-12 inline-flex min-h-14 items-center justify-center rounded-full bg-emerald-300 px-8 text-base font-bold text-[#07110D] transition hover:bg-emerald-200 focus:outline-none focus:ring-2 focus:ring-emerald-200 focus:ring-offset-2 focus:ring-offset-[#0B0F14]"
        >
          See your plan
        </Link>
      </section>

      <section className="px-6 pb-24 sm:px-8">
        <div className="mx-auto max-w-6xl rounded-lg border border-white/10 bg-[#0E141C] p-3 shadow-2xl shadow-black/30 sm:p-4">
          <div className="flex min-h-[320px] items-center justify-center rounded-lg border border-white/10 bg-[linear-gradient(135deg,rgba(255,255,255,0.08),rgba(255,255,255,0.02))] sm:min-h-[440px]">
            <div className="text-center">
              <div className="text-sm font-semibold uppercase tracking-[0.22em] text-zinc-500">Dashboard Preview</div>
              <div className="mx-auto mt-5 h-1 w-24 rounded-full bg-emerald-300/60" />
            </div>
          </div>
        </div>
      </section>

      <section className="mx-auto grid max-w-6xl gap-16 px-6 py-24 sm:px-8 lg:grid-cols-[0.95fr_1.05fr] lg:items-center">
        <div>
          <p className="text-4xl font-bold leading-tight text-white sm:text-5xl">
            You check your balance.
            <br />
            You check your bills.
            <br />
            You still don&apos;t know what to do.
          </p>
        </div>
        <div className="border-l border-white/10 pl-8">
          <p className="max-w-xl text-2xl font-semibold leading-snug text-zinc-300">
            Most apps show numbers.
            <br />
            They don&apos;t make decisions.
          </p>
        </div>
      </section>

      <section className="bg-[#0E141C] px-6 py-24 sm:px-8">
        <div className="mx-auto max-w-6xl">
          <div className="max-w-3xl">
            <h2 className="text-4xl font-bold leading-tight text-white sm:text-5xl">
              Accountant Bot is a Financial Operating System.
            </h2>
            <p className="mt-6 text-2xl leading-snug text-zinc-300">
              It tells you what to do with your money.
            </p>
          </div>

          <div className="mt-14 grid gap-4 sm:grid-cols-3">
            {decisions.map((decision) => (
              <div key={decision} className="rounded-lg border border-white/10 bg-white/[0.03] p-6">
                <div className="mb-5 h-2 w-2 rounded-full bg-emerald-300" />
                <p className="text-xl font-semibold text-white">{decision}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-6 py-24 sm:px-8">
        <h2 className="text-center text-4xl font-bold text-white sm:text-5xl">How it works</h2>
        <div className="mt-14 grid gap-4 md:grid-cols-3">
          {steps.map((step, index) => (
            <div key={step} className="rounded-lg border border-white/10 bg-[#0E141C] p-6">
              <div className="flex h-11 w-11 items-center justify-center rounded-full bg-emerald-300 text-sm font-bold text-[#07110D]">
                {index + 1}
              </div>
              <p className="mt-8 text-2xl font-semibold text-white">{step}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="px-6 py-24 text-center sm:px-8">
        <div className="mx-auto max-w-4xl">
          <p className="text-4xl font-bold leading-tight text-white sm:text-6xl">
            Not Mint. Not Copilot. Not a spreadsheet.
          </p>
          <p className="mt-8 text-3xl font-semibold text-emerald-200 sm:text-4xl">This is a system.</p>
        </div>
      </section>

      <section className="bg-[#0E141C] px-6 py-24 text-center sm:px-8">
        <div className="mx-auto max-w-4xl">
          <h2 className="text-4xl font-bold leading-tight text-white sm:text-5xl">
            Start using your Financial OS
          </h2>
          <Link
            href="/signup"
            className="mt-10 inline-flex min-h-14 items-center justify-center rounded-full bg-white px-8 text-base font-bold text-[#0B0F14] transition hover:bg-zinc-200 focus:outline-none focus:ring-2 focus:ring-white focus:ring-offset-2 focus:ring-offset-[#0E141C]"
          >
            See your plan
          </Link>
        </div>
      </section>
    </main>
  );
}
