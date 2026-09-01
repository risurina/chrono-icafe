"use client";

import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";
import { Button, Card, CardContent, CardHeader, CardTitle } from "agora/ui";

export default function GlobalError({
  error,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html>
      <body>
        <Card className="m-8 max-w-md">
          <CardHeader>
            <CardTitle>Something went wrong</CardTitle>
          </CardHeader>
          <CardContent>
            <Button onClick={() => window.location.reload()}>Reload</Button>
          </CardContent>
        </Card>
      </body>
    </html>
  );
}
