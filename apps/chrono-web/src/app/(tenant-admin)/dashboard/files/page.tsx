"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Trash2, X, Copy, Download } from "lucide-react";
import {
  Button,
  Stack,
  Row,
  DataTable,
  DataTableGrid,
  DataTableToolbar,
  DataTablePagination,
  useListQuery,
  type DataTableColumn,
  Label,
  Switch,
  Badge,
  toast,
  useRegisterUploadTarget,
  Dropzone,
} from "agora/ui";
import { api } from "@/lib/rpc";
import { type PaginationMeta, type StoredFile } from "agora";
import { uploadFile, type UploadTarget } from "@/lib/upload";

export default function FilesPage() {
  const [files, setFiles] = useState<StoredFile[]>([]);
  const [meta, setMeta] = useState<PaginationMeta | null>(null);
  const [isPublic, setIsPublic] = useState(false);
  const [loading, setLoading] = useState(false);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const query = useListQuery();

  // Global drag/drop + paste (packages/agora/src/ui/components/custom/global-upload.tsx)
  // overrides the dashboard's default "general" target with this page's own
  // feature tag while mounted, honoring the current Public-file toggle.
  const uploadTarget = useMemo<UploadTarget>(
    () => ({ kind: "tenant", feature: "files", visibility: isPublic ? "public" : "private" }),
    [isPublic],
  );
  useRegisterUploadTarget<UploadTarget>(uploadTarget);

  const load = useCallback(async () => {
    const res = await api.rpc.files.$get({
      query: {
        page: String(query.page),
        pageSize: String(query.pageSize),
        q: query.q || undefined,
        sort: query.sort,
        order: query.order,
      },
    });
    if (res.ok) {
      const body = await res.json();
      setFiles(body.items as StoredFile[]);
      setMeta(body.meta as PaginationMeta);
    }
  }, [query.page, query.pageSize, query.q, query.sort, query.order]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleUpload(f: File) {
    setLoading(true);
    
    const result = await uploadFile(f, {
      kind: "tenant",
      feature: "files",
      visibility: isPublic ? "public" : "private",
    });

    if (!result.ok) {
      toast.error(result.message);
      setLoading(false);
      return;
    }

    setLoading(false);
    setIsPublic(false);
    load();
  }

  async function remove(id: string) {
    setConfirmingId(null);
    const res = await api.rpc.files[":id"].$delete({ param: { id } });
    if (res.ok) load();
    else if ((res.status as number) === 403)
      toast.error("Only admins can delete files.");
    else toast.error("Could not delete file.");
  }

  async function copyUrl(url: string) {
    // `navigator.clipboard` only exists in a secure context (https, or the
    // literal hostname "localhost") — it is undefined on the http
    // `*.localtest.me` tenant hosts this app runs on in dev, so fall back to
    // the legacy execCommand path rather than silently doing nothing.
    if (navigator.clipboard) {
      try {
        await navigator.clipboard.writeText(url);
        return;
      } catch (err) {
        console.error("Failed to copy URL", err);
      }
    }
    const textarea = document.createElement("textarea");
    textarea.value = url;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    try {
      const copied = document.execCommand("copy");
      if (!copied) toast.error("Could not copy the URL — copy it manually.");
    } catch (err) {
      console.error("Failed to copy URL", err);
      toast.error("Could not copy the URL — copy it manually.");
    } finally {
      document.body.removeChild(textarea);
    }
  }

  async function downloadFile(id: string) {
    const res = await api.rpc.files[":id"]["download-url"].$get({ param: { id } });
    if (res.ok) {
      const { url } = await res.json();
      window.open(url, "_blank");
    } else {
      toast.error("Could not get download URL.");
    }
  }

  function formatBytes(bytes: number) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  function renderActions(f: StoredFile) {
    return (
      <Row items="center" gap={2}>
        {f.visibility === "public" && f.publicUrl ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => copyUrl(f.publicUrl!)}
            title="Copy URL"
          >
            <Copy className="h-4 w-4 mr-2" />
            Copy URL
          </Button>
        ) : null}
        
        {f.visibility === "private" ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => downloadFile(f.id)}
            title="Download"
          >
            <Download className="h-4 w-4 mr-2" />
            Download
          </Button>
        ) : null}

        {confirmingId === f.id ? (
          <Row items="center">
            <span className="text-xs text-muted-foreground mr-2">Delete?</span>
            <Button variant="destructive" size="sm" onClick={() => remove(f.id)}>
              Confirm
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Cancel delete"
              onClick={() => setConfirmingId(null)}
            >
              <X className="h-4 w-4" />
            </Button>
          </Row>
        ) : (
          <Button
            variant="ghost"
            size="icon"
            aria-label={`Delete ${f.originalName}`}
            onClick={() => setConfirmingId(f.id)}
          >
            <Trash2 className="h-4 w-4 text-destructive" />
          </Button>
        )}
      </Row>
    );
  }

  const columns: DataTableColumn<StoredFile>[] = [
    { key: "originalName", header: "Name", sortable: true },
    { 
      key: "visibility", 
      header: "Visibility",
      render: (f) => (
        <Badge variant={f.visibility === "public" ? "success" : "secondary"}>
          {f.visibility}
        </Badge>
      )
    },
    {
      key: "sizeBytes",
      header: "Size",
      render: (f) => formatBytes(f.sizeBytes),
    },
    {
      key: "createdAt",
      header: "Created",
      sortable: true,
      render: (f) => new Date(f.createdAt).toLocaleString(),
    },
    { key: "actions", header: "", render: renderActions },
  ];

  return (
    <Stack>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Files</h1>
        <p className="text-sm text-muted-foreground">
          Tenant-scoped file storage. Upload public assets or private documents.
        </p>
      </div>

      <div className="flex flex-col gap-4 max-w-xl">
        <Row items="center" gap={4}>
          <div className="flex-1">
            <Dropzone
              id="file-input"
              uploading={loading}
              onFiles={(files) => {
                const f = files[0];
                if (f) handleUpload(f);
              }}
            />
          </div>
          <Row items="center" gap={2}>
            <Switch 
              id="visibility" 
              checked={isPublic} 
              onCheckedChange={setIsPublic} 
            />
            <Label htmlFor="visibility">Public file</Label>
          </Row>
        </Row>
      </div>

      <DataTableToolbar
        q={query.q}
        onQChange={query.setQ}
        searchPlaceholder="Search files…"
        view={query.view}
        onViewChange={query.setView}
      />

      {query.view === "grid" ? (
        <DataTableGrid
          rows={files}
          rowKey={(f) => f.id}
          emptyMessage="No files yet."
          renderCard={(f) => (
            <div className="flex flex-col gap-4">
              <div>
                <Row items="center" gap={2}>
                  <p className="font-medium truncate" title={f.originalName}>{f.originalName}</p>
                  <Badge variant={f.visibility === "public" ? "success" : "secondary"}>
                    {f.visibility}
                  </Badge>
                </Row>
                <p className="text-xs text-muted-foreground mt-1">
                  {formatBytes(f.sizeBytes)} • {new Date(f.createdAt).toLocaleString()}
                </p>
              </div>
              <div className="flex justify-end mt-auto">
                {renderActions(f)}
              </div>
            </div>
          )}
        />
      ) : (
        <DataTable
          columns={columns}
          rows={files}
          rowKey={(f) => f.id}
          sort={query.sort}
          order={query.order}
          onSortChange={query.setSort}
          emptyMessage="No files yet."
        />
      )}

      {meta ? (
        <DataTablePagination
          meta={meta}
          onPageChange={query.setPage}
          onPageSizeChange={query.setPageSize}
        />
      ) : null}
    </Stack>
  );
}
