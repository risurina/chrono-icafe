"use client";

import { ArrowDown, ArrowUp } from "lucide-react";
import { Button, Label, Row, Stack, Switch } from "agora/ui";
import type { SectionsConfig } from "agora";

export type SectionChoice = { key: string; label: string };

/**
 * Section visibility + ordering.
 *
 * Writes the foundation's `{ order, hidden }` shape. `order` lists only the
 * sections the tenant has deliberately arranged, so a section registered later
 * still appears (subject to its `defaultEnabled`) without anyone rewriting a
 * stored array.
 */
export function SectionsEditor({
  choices,
  value,
  onChange,
}: {
  choices: SectionChoice[];
  value: SectionsConfig;
  onChange: (next: SectionsConfig) => void;
}) {
  const hidden = new Set(value.hidden ?? []);
  // Stored order first, then anything not yet arranged, so the list the user
  // sees matches the order the page will render.
  const ordered = [
    ...(value.order ?? []).filter((k) => choices.some((c) => c.key === k)),
    ...choices.map((c) => c.key).filter((k) => !(value.order ?? []).includes(k)),
  ];

  const move = (key: string, delta: number) => {
    const i = ordered.indexOf(key);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= ordered.length) return;
    const next = [...ordered];
    const [item] = next.splice(i, 1);
    if (item) next.splice(j, 0, item);
    onChange({ ...value, order: next });
  };

  const toggle = (key: string, visible: boolean) => {
    const nextHidden = new Set(hidden);
    if (visible) nextHidden.delete(key);
    else nextHidden.add(key);
    onChange({ ...value, hidden: [...nextHidden] });
  };

  return (
    <Stack gap={3}>
      <Label>Sections</Label>
      <Stack gap={2}>
        {ordered.map((key, index) => {
          const choice = choices.find((c) => c.key === key);
          if (!choice) return null;
          const visible = !hidden.has(key);
          return (
            <Row
              key={key}
              className="items-center justify-between rounded-md border p-3"
              data-testid={`section-row-${key}`}
            >
              <Row className="items-center gap-3">
                <Switch
                  checked={visible}
                  onCheckedChange={(next) => toggle(key, next)}
                  aria-label={`Show ${choice.label}`}
                  data-testid={`section-toggle-${key}`}
                />
                <span className={visible ? undefined : "text-muted-foreground"}>
                  {choice.label}
                </span>
              </Row>
              <Row className="gap-1">
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  aria-label={`Move ${choice.label} up`}
                  disabled={index === 0}
                  onClick={() => move(key, -1)}
                  className="h-8 w-8 border-0 text-muted-foreground hover:text-foreground focus-visible:ring-0 focus-visible:ring-offset-0"
                >
                  <ArrowUp className="h-4 w-4" aria-hidden />
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  aria-label={`Move ${choice.label} down`}
                  disabled={index === ordered.length - 1}
                  onClick={() => move(key, 1)}
                  className="h-8 w-8 border-0 text-muted-foreground hover:text-foreground focus-visible:ring-0 focus-visible:ring-offset-0"
                >
                  <ArrowDown className="h-4 w-4" aria-hidden />
                </Button>
              </Row>
            </Row>
          );
        })}
      </Stack>
    </Stack>
  );
}
