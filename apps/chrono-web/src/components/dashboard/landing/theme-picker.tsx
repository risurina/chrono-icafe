"use client";

import { Button, Label, Row, Stack } from "agora/ui";
import { cn } from "agora/ui/cn";
import { listThemePresets } from "agora";
import { CHRONO_THEME_PRESETS, presetSwatch } from "@/lib/theme-presets";

/**
 * Theme preset picker.
 *
 * Swatch buttons rather than a `Select` (which `agora/ui` does export): a
 * colour choice should show the colour, and a closed dropdown hides exactly
 * the information the user is choosing on.
 */
export function ThemePicker({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (key: string | null) => void;
}) {
  const presets = listThemePresets(CHRONO_THEME_PRESETS);
  const active = value ?? CHRONO_THEME_PRESETS.defaultKey;

  return (
    <Stack gap={2}>
      <Label>Theme</Label>
      <Row wrap className="gap-2">
        {presets.map((preset) => {
          const selected = preset.key === active;
          return (
            <Button
              key={preset.key}
              type="button"
              variant={selected ? "default" : "outline"}
              aria-pressed={selected}
              data-testid={`theme-preset-${preset.key}`}
              onClick={() =>
                // Storing null for the default keeps the row free of a value
                // that only restates the app's own stylesheet.
                onChange(preset.isDefault ? null : preset.key)
              }
              className="gap-2"
            >
              <span
                aria-hidden
                className={cn("h-3 w-3 rounded-full border border-border")}
                style={{ backgroundColor: presetSwatch(preset.key) }}
              />
              {preset.label}
            </Button>
          );
        })}
      </Row>
    </Stack>
  );
}
