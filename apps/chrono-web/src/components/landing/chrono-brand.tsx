import Image from "next/image";
import { Stack } from "agora/ui";
import { cn } from "agora/ui/cn";

/**
 * The Chrono lockup: owl mark + wordmark + "BY IZUR" line.
 *
 * `next/image` at fixed dimensions rather than the reference's raw `<img>` of a
 * favicon, and the wordmark uses the `font-chrono` utility with
 * `premium-text-gradient` so it follows `--primary` — a theme preset or a
 * tenant's brand colour re-tints it with no change here.
 */
export function ChronoBrand({
  subtitle = "by IZUR",
  className,
}: {
  subtitle?: string | null;
  className?: string;
}) {
  return (
    <span className={cn("group flex items-center gap-2", className)}>
      <Image
        src="/brand/chrono-owl.png"
        alt=""
        width={48}
        height={48}
        priority
        className="h-10 w-10 object-contain transition-transform group-hover:scale-105"
      />
      <Stack gap={0} className="leading-none">
        <span className="premium-text-gradient font-chrono text-xl font-black uppercase tracking-tighter">
          Chrono
        </span>
        {subtitle ? (
          <span className="text-[9px] font-black uppercase tracking-[0.4em] text-primary/60">
            {subtitle}
          </span>
        ) : null}
      </Stack>
    </span>
  );
}
