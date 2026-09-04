import Image from "next/image";
import { Row, Stack } from "agora/ui";
import { cn } from "agora/ui/cn";

const MARK = {
  sm: { px: 40, cls: "h-10 w-10" },
  md: { px: 48, cls: "h-12 w-12" },
} as const;

const WORDMARK = {
  sm: "text-xl",
  md: "text-2xl",
} as const;

/**
 * The Chrono lockup: owl mark + wordmark + "BY IZUR" line.
 *
 * `next/image` at fixed dimensions rather than the reference's raw `<img>` of a
 * favicon. The wordmark uses the `font-chrono` utility with
 * `premium-text-gradient` so it follows `--primary` — a theme preset or a
 * tenant's brand colour re-tints it with no change here. `gradient={false}`
 * gives the flat-primary variant the reference uses in its footer.
 */
export function ChronoBrand({
  subtitle = "by IZUR",
  size = "md",
  gradient = true,
  className,
}: {
  subtitle?: string | null;
  size?: keyof typeof MARK;
  gradient?: boolean;
  className?: string;
}) {
  const mark = MARK[size];

  return (
    <Row gap={3} items="center" className={cn("group", className)}>
      <Image
        src="/brand/chrono-owl.png"
        alt=""
        width={mark.px}
        height={mark.px}
        priority
        className={cn(
          mark.cls,
          "object-contain transition-transform group-hover:rotate-3 group-hover:scale-105",
        )}
      />
      {/* `flex flex-col` explicitly: Stack is a `space-y-*` block, and inline
          spans inside a block box flow side by side rather than stacking. */}
      <Stack gap={0} className="flex flex-col leading-none">
        <span
          className={cn(
            "font-chrono font-black uppercase tracking-tighter",
            WORDMARK[size],
            gradient ? "premium-text-gradient" : "text-primary",
          )}
        >
          Chrono
        </span>
        {subtitle ? (
          <span className="ml-1 text-[9px] font-black uppercase tracking-[0.4em] text-primary/60">
            {subtitle}
          </span>
        ) : null}
      </Stack>
    </Row>
  );
}
