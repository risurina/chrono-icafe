"use client";

/**
 * Member avatar upload — a small client island for the profile page's Hero
 * card. Consumes the foundation's sign/confirm ticket flow
 * (`memberAuth.getAvatarUploadTicket` / `memberAuth.confirmAvatar`, see
 * `packages/agora/src/presentation/client/index.ts`) exactly like the
 * server's own `signUpload`/`sniffImage` pair validates it
 * (`packages/agora/src/core/server/providers/storage/sniff.ts`) — the
 * client-side guard below mirrors those exact limits so a rejection happens
 * before any network call, not as a guess.
 */

import { useRef, useState } from "react";
import { User } from "lucide-react";
import { Button, Input, toast } from "agora/ui";
import { cn } from "agora/ui/cn";
import type { UploadTicket } from "agora";
import { memberAuth } from "@/lib/member-client";

// Mirrors packages/agora/src/core/server/providers/storage/sniff.ts exactly —
// the server sniffs magic bytes against this same set and rejects anything
// larger, so a client-side mismatch would only produce a confusing
// server-side 400 after an upload already started.
const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
const ALLOWED_AVATAR_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/x-icon",
] as const;

async function consumeUploadTicket(ticket: UploadTicket, file: File): Promise<void> {
  // Multipart form fields + the file, regardless of method — matches this
  // app's existing upload-ticket-consumption pattern
  // (`apps/chrono-web/src/lib/upload.ts`'s `uploadFile`), which the local
  // dev storage adapter's proxy (`PUT /api/upload/local`,
  // `apps/chrono-api/src/app.ts`) expects: it reads the file via
  // `c.req.parseBody()`'s `file` field, not a raw request body. No explicit
  // Content-Type header — the browser sets the multipart boundary.
  const formData = new FormData();
  for (const [key, value] of Object.entries(ticket.fields)) {
    formData.append(key, value);
  }
  formData.append("file", file);
  const res = await fetch(ticket.url, {
    method: ticket.method,
    headers: ticket.headers ?? undefined,
    body: formData,
  });
  if (!res.ok) throw new Error(`Upload failed (${res.status})`);
}

export function AvatarUploadField({
  name,
  image,
  onUploaded,
}: {
  name?: string | null;
  image: string | null;
  onUploaded: (image: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [preview, setPreview] = useState<string | null>(image);

  async function onFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;

    if (!ALLOWED_AVATAR_TYPES.includes(file.type as (typeof ALLOWED_AVATAR_TYPES)[number])) {
      toast.error("Unsupported image type. Use PNG, JPEG, GIF, WEBP, or ICO.");
      return;
    }
    if (file.size > MAX_AVATAR_BYTES) {
      toast.error("Image is too large. Max size is 2 MB.");
      return;
    }

    setUploading(true);
    try {
      const { data: ticket, error: ticketError } = await memberAuth.getAvatarUploadTicket(
        file.type,
      );
      if (!ticket) {
        toast.error(ticketError ?? "Could not start the upload.");
        return;
      }

      await consumeUploadTicket(ticket, file);

      const { data: member, error: confirmError } = await memberAuth.confirmAvatar(ticket.key);
      if (!member) {
        toast.error(confirmError ?? "Could not save your new avatar.");
        return;
      }

      setPreview(member.image);
      onUploaded(member.image ?? "");
      toast.success("Avatar updated.");
    } catch {
      toast.error("Could not upload your avatar. Please try again.");
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="flex items-center gap-3">
      <span
        className={cn(
          "flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-primary/20 bg-primary/10",
        )}
      >
        {preview ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={preview} alt={name ? `${name}'s avatar` : "Avatar"} className="h-full w-full object-cover" />
        ) : (
          <User className="h-5 w-5 text-primary" aria-hidden />
        )}
      </span>
      <Input
        ref={inputRef}
        type="file"
        accept={ALLOWED_AVATAR_TYPES.join(",")}
        className="hidden"
        onChange={onFileSelected}
      />
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={uploading}
        onClick={() => inputRef.current?.click()}
      >
        {uploading ? "Uploading…" : "Change avatar"}
      </Button>
    </div>
  );
}
