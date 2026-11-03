// Cron strings in words, and the view's own "<10 min" noise rule (the contract leaves both to the view). Neither is
// ever used to compute fire times: next fires come from Candybar's /schedule, which owns DST and skips.

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const pad = (n: number) => String(n).padStart(2, "0");
const isNum = (f: string) => /^\d+$/.test(f);

export const NOISE_MINUTES = 10;

/** The minutes of the hour a cron minute field selects (`*`, `n`, `a-b`, `*\/s`, `a-b/s`, and lists of them). */
export function minutesOf(field: string): number[] | undefined {
  const out = new Set<number>();
  for (const part of field.split(",")) {
    const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
    if (!m) return undefined;
    const stride = m[2] ? Number(m[2]) : 1;
    let lo = 0;
    let hi = 59;
    if (m[1] !== "*") {
      const [a, b] = m[1].split("-").map(Number);
      lo = a;
      hi = b ?? (m[2] ? 59 : a);
    }
    if (stride < 1 || lo > hi || hi > 59) return undefined;
    for (let x = lo; x <= hi; x += stride) out.add(x);
  }
  return [...out].sort((a, b) => a - b);
}

/** The longest gap between fires within an hour of a minute field, wrapping into the next hour. */
function longestGap(minutes: number[]): number {
  return Math.max(...minutes.map((x, i) => (i ? x - minutes[i - 1] : x + 60 - minutes[minutes.length - 1])));
}

/** An even stride across the whole hour (`*\/5`, `1-59/5`, `7,22,37,52`), or undefined. */
function evenStride(minutes: number[]): number | undefined {
  if (minutes.length < 2) return undefined;
  const s = minutes[1] - minutes[0];
  return minutes.every((x, i) => !i || x - minutes[i - 1] === s) && minutes[0] + 60 - minutes[minutes.length - 1] === s ? s : undefined;
}

/** Fires more often than every 10 minutes during any hour it runs in. */
export function isFrequent(expr: string): boolean {
  const minutes = minutesOf(expr.trim().split(/\s+/)[0] ?? "");
  return !!minutes && minutes.length > 1 && longestGap(minutes) < NOISE_MINUTES;
}

function ordinal(n: number): string {
  const s = n % 100 >= 11 && n % 100 <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th");
  return `${n}${s}`;
}

/** The common cron shapes in words, read in the candybar's own timezone; anything else is undefined. */
export function describeCron(expr: string): string | undefined {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) return undefined;
  const [min, hour, dom, mon, dow] = f;
  if (mon !== "*") return undefined;
  const minutes = minutesOf(min);
  if (!minutes) return undefined;
  const at = isNum(min) && isNum(hour) ? `${pad(Number(hour))}:${pad(Number(min))}` : undefined;
  if (dom === "*" && dow === "*") {
    if (hour === "*") {
      if (minutes.length === 60) return "every minute";
      const stride = evenStride(minutes);
      if (stride) return `every ${stride} min`;
      if (minutes.length === 1) return `hourly at :${pad(minutes[0])}`;
      return undefined;
    }
    const hourStride = /^\*\/(\d+)$/.exec(hour);
    if (hourStride && minutes.length === 1) return `every ${hourStride[1]} h at :${pad(minutes[0])}`;
    return at ? `daily ${at}` : undefined;
  }
  if (!at) return undefined;
  if (dom === "*" && /^[0-7](,[0-7])*$/.test(dow)) return `${dow.split(",").map((d) => DOW[Number(d)]).join(", ")} ${at}`;
  if (dom === "*" && dow === "1-5") return `weekdays ${at}`;
  if (isNum(dom) && dow === "*") return `monthly on the ${ordinal(Number(dom))} ${at}`;
  return undefined;
}
