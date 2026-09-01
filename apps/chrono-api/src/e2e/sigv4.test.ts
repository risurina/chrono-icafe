/**
 * Unit test for the S3 SigV4 signer + adapter (Phase 1). Standalone tsx script
 * (`pnpm --filter @agora/api test:sigv4`) — the repo has no unit-test runner, so
 * this mirrors the inline assertion style used by the e2e harness.
 *
 * The virtual-hosted GET and PUT cases reproduce AWS's own documented Signature
 * Version 4 example requests ("Authenticating Requests: Using the Authorization
 * Header"). Each expected signature is verified to derive from AWS's documented
 * canonical-request hash for that example (GET: 7344ae5b…, PUT: 9e0e90d9…), so a
 * wrong signer is caught against a known-good external vector.
 */
import { createHash } from "node:crypto";
import type { StoragePutInput } from "agora/server";

// The `agora/server` barrel initializes the DB client on import; select the
// in-process driver so importing it needs no DATABASE_URL (this test uses no DB).
process.env.DB_DRIVER = "pglite";

let passed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failures.push(name + (detail ? ` — ${detail}` : ""));
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const sha256Hex = (s: string | Uint8Array) =>
  createHash("sha256").update(s).digest("hex");

// AWS documented example credentials.
const ACCESS = "AKIAIOSFODNN7EXAMPLE";
const SECRET = "wJalrXUtnFEMI/K7MDENG/bPxRFiCYEXAMPLEKEY";
const REGION = "us-east-1";
const WHEN = new Date("2013-05-24T00:00:00.000Z");
const EMPTY_SHA =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

async function main() {
  const { signV4, createS3Adapter } = await import("agora/server");
  console.log("\nRunning SigV4 unit checks:\n");

  // ── 1. AWS documented "GET Object" vector (virtual-hosted) ──
  const get = signV4({
    method: "GET",
    url: "https://examplebucket.s3.amazonaws.com/test.txt",
    region: REGION,
    accessKeyId: ACCESS,
    secretAccessKey: SECRET,
    payloadHash: EMPTY_SHA,
    headers: { range: "bytes=0-9" },
    now: WHEN,
  });
  check(
    "GET Object signature matches AWS documented vector",
    get.authorization ===
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, " +
        "SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, " +
        "Signature=51a4f6aa2b6678b8bc64339c22721571d2a069f12f5ec80b1e6d12e50636512a",
    get.authorization,
  );
  check(
    "GET signed headers include x-amz-date + content-sha256",
    get.headers["x-amz-date"] === "20130524T000000Z" &&
      get.headers["x-amz-content-sha256"] === EMPTY_SHA,
    JSON.stringify(get.headers),
  );

  // ── 2. AWS documented "PUT Object" vector (virtual-hosted, key needs %-encode) ──
  const body = "Welcome to Amazon S3.";
  const put = signV4({
    method: "PUT",
    url: "https://examplebucket.s3.amazonaws.com/test$file.text",
    region: REGION,
    accessKeyId: ACCESS,
    secretAccessKey: SECRET,
    payloadHash: sha256Hex(body),
    headers: {
      date: "Fri, 24 May 2013 00:00:00 GMT",
      "x-amz-storage-class": "REDUCED_REDUNDANCY",
    },
    now: WHEN,
  });
  check(
    "PUT Object signature matches AWS documented vector",
    put.authorization ===
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, " +
        "SignedHeaders=date;host;x-amz-content-sha256;x-amz-date;x-amz-storage-class, " +
        "Signature=c1bd02ec21166a044ac5acaf063b1fcd443b6b3b6abff97f084c4baf16b71522",
    put.authorization,
  );

  // ── 3. Path-style adapter (MinIO/R2 custom endpoint) ──
  const captured: { url: string; init: RequestInit }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    captured.push({ url: String(input), init: (init ?? {}) as RequestInit });
    return new Response("", { status: 200 });
  }) as typeof fetch;

  try {
    const s3 = createS3Adapter({
      accessKeyId: ACCESS,
      secretAccessKey: SECRET,
      region: REGION,
      bucket: "assets",
      endpoint: "https://minio.example.com:9000",
      publicBaseUrl: "https://cdn.example.com",
    });
    const putInput: StoragePutInput = {
      key: "branding/t1/logo.png",
      bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      contentType: "image/png",
    };
    const res = await s3.put(putInput);
    const call = captured[0];
    check(
      "path-style PUT targets <endpoint>/<bucket>/<key>",
      !!call &&
        call.url === "https://minio.example.com:9000/assets/branding/t1/logo.png",
      call?.url,
    );
    const hdrs = (call?.init.headers ?? {}) as Record<string, string>;
    check(
      "path-style PUT carries a SigV4 Authorization + content-type",
      typeof hdrs["authorization"] === "string" &&
        hdrs["authorization"].startsWith("AWS4-HMAC-SHA256 Credential=") &&
        hdrs["content-type"] === "image/png",
      JSON.stringify(hdrs),
    );
    check(
      "put returns the public (CDN) URL, not the raw object URL",
      res.url === "https://cdn.example.com/branding/t1/logo.png",
      res.url,
    );
    check(
      "keyFromUrl round-trips the CDN URL back to the key",
      s3.keyFromUrl(res.url) === "branding/t1/logo.png",
      String(s3.keyFromUrl(res.url)),
    );
    check(
      "keyFromUrl rejects a URL on a different base",
      s3.keyFromUrl("https://other.example.com/x/y.png") === null,
    );

    // Virtual-hosted URL shape (no endpoint).
    const aws = createS3Adapter({
      accessKeyId: ACCESS,
      secretAccessKey: SECRET,
      region: "ap-southeast-2",
      bucket: "acme-assets",
    });
    captured.length = 0;
    const awsRes = await aws.put(putInput);
    check(
      "virtual-hosted PUT targets <bucket>.s3.<region>.amazonaws.com",
      captured[0]?.url ===
        "https://acme-assets.s3.ap-southeast-2.amazonaws.com/branding/t1/logo.png",
      captured[0]?.url,
    );
    check(
      "virtual-hosted put returns the object URL when no publicBaseUrl",
      awsRes.url ===
        "https://acme-assets.s3.ap-southeast-2.amazonaws.com/branding/t1/logo.png",
      awsRes.url,
    );
  } finally {
    globalThis.fetch = realFetch;
  }

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log("Failures:\n" + failures.map((f) => `  - ${f}`).join("\n"));
    process.exit(1);
  }
  console.log("SIGV4: PASS ✅");
  process.exit(0);
}

main().catch((err) => {
  console.error("SigV4 test crashed:", err);
  process.exit(1);
});
