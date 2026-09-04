import { Row } from "agora/ui";
import { cn } from "agora/ui/cn";

/**
 * The hero's capability strip: a glowing primary dot + a tiny uppercase label
 * per item, between hairline rules.
 *
 * This is the reference's treatment for "what the product does" directly under
 * the hero copy — deliberately *not* a row of bordered stat cards, which reads
 * as data rather than as a capability list.
 */
export function HeroChips({
  items,
  className,
}: {
  items: readonly string[];
  className?: string;
}) {
  return (
    <Row
      wrap
      gap={0}
      className={cn(
        "w-full gap-x-8 gap-y-5 border-y border-primary/10 py-4",
        className,
      )}
    >
      {items.map((label) => (
        <Row key={label} items="center" gap={2} className="gap-2.5">
          <span
            aria-hidden
            className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary shadow-[0_0_8px_var(--color-primary)]"
          />
          <span className="text-[10px] font-black uppercase tracking-[0.2em] text-primary/90">
            {label}
          </span>
        </Row>
      ))}
    </Row>
  );
}
