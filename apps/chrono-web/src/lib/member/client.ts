import { api } from "@/lib/rpc";

export { api };

export type Ok<T> = { data: T; error: null };
export type Err = { data: null; error: string };
export type Result<T> = Ok<T> | Err;

/** Shared response unwrapper for `api.portal.*` calls — every `lib/member/*`
 * wrapper narrows the typed client's raw JSON to an explicit DTO through this,
 * mirroring the one-`unwrap<T>`-helper pattern used elsewhere in the app. */
export async function unwrap<T>(
  res: Response,
  map: (json: unknown) => T,
): Promise<Result<T>> {
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    const message =
      body && typeof body === "object" && "error" in body && typeof body.error === "string"
        ? body.error
        : `Request failed (${res.status})`;
    return { data: null, error: message };
  }
  const json = await res.json();
  return { data: map(json), error: null };
}
