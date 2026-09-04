"use client";

import { ThemeProvider } from "next-themes";
import { Toaster, GlobalUploadProvider } from "agora/ui";
import type { ReactNode } from "react";
import { uploadFile, type UploadTarget } from "@/lib/upload";

export function Providers({ children }: { children: ReactNode }) {
  // Dark by default: Chrono's brand surface is the dark elegant-gold palette,
  // and a light-mode visitor otherwise lands on a washed-out version of it.
  // `enableSystem` is kept so "System" stays selectable in the toggle — this
  // changes the default, not the choice.
  return (
    <ThemeProvider attribute="class" defaultTheme="dark" enableSystem>
      <GlobalUploadProvider<UploadTarget> onUpload={uploadFile}>
        {children}
      </GlobalUploadProvider>
      <Toaster />
    </ThemeProvider>
  );
}
