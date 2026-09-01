"use client";

import { ThemeProvider } from "next-themes";
import { Toaster, GlobalUploadProvider } from "agora/ui";
import type { ReactNode } from "react";
import { uploadFile, type UploadTarget } from "@/lib/upload";

export function Providers({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
      <GlobalUploadProvider<UploadTarget> onUpload={uploadFile}>
        {children}
      </GlobalUploadProvider>
      <Toaster />
    </ThemeProvider>
  );
}
