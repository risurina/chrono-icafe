import { api } from "@/lib/rpc";
import { adminApi } from "@/lib/admin-client";
import { ALLOWED_FILE_TYPES } from "agora";

/**
 * Where an upload should land. `tenant` uses the session's own tenant
 * (`/rpc/files/*`); `admin-org` is a platform admin already viewing one
 * org's detail page, uploading into THAT org's own file store
 * (`/rpc-admin/organizations/:id/files/*`) — see
 * `.ai/plans/agora/archive/global-upload-drag-drop-paste/README.md`.
 */
export type UploadTarget =
  | { kind: "tenant"; feature: string; visibility: "public" | "private" }
  | { kind: "admin-org"; orgId: string; feature: string; visibility: "public" | "private" };

export async function uploadFile(
  file: File,
  target: UploadTarget,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const signJson = {
    originalName: file.name,
    contentType: file.type as (typeof ALLOWED_FILE_TYPES)[number],
    sizeBytes: file.size,
    visibility: target.visibility,
    feature: target.feature,
  };

  // Step 1: Sign the upload
  const signRes =
    target.kind === "tenant"
      ? await api.rpc.files.sign.$post({ json: signJson })
      : await adminApi["rpc-admin"].organizations[":id"].files.sign.$post({
          param: { id: target.orgId },
          json: signJson,
        });

  if (!signRes.ok) {
    return {
      ok: false,
      message:
        (signRes.status as number) === 403
          ? "You don't have permission to upload here."
          : "Could not start the upload.",
    };
  }

  const { ticket, fileId } = await signRes.json();

  // Step 2: Upload to provider directly
  const formData = new FormData();
  for (const [key, value] of Object.entries(ticket.fields)) {
    formData.append(key, value as string);
  }
  formData.append("file", file);

  const uploadRes = await fetch(ticket.url, {
    method: ticket.method,
    headers: ticket.headers || undefined,
    body: formData,
  });

  if (!uploadRes.ok) {
    return { ok: false, message: "Upload to storage provider failed." };
  }

  // Step 3: Confirm the upload
  const confirmJson = { sizeBytes: file.size, storageKey: ticket.key };
  const confirmRes =
    target.kind === "tenant"
      ? await api.rpc.files[":id"].confirm.$post({
          param: { id: fileId },
          json: confirmJson,
        })
      : await adminApi["rpc-admin"].organizations[":id"].files[":fileId"].confirm.$post({
          param: { id: target.orgId, fileId },
          json: confirmJson,
        });

  if (!confirmRes.ok) {
    return { ok: false, message: "Could not confirm the upload." };
  }

  return { ok: true };
}
