"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import type { BusinessDirectoryResult } from "@agora/chrono-api/business-lead";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  Button,
  Label,
  Input,
  Field,
  Stack,
  Row,
  toast,
} from "agora/ui";
import { searchBusinesses } from "../../../lib/discover-client";
import { track } from "../../../lib/analytics";
import { BusinessResultCard } from "./business-result-card";
import { InviteBusinessForm } from "./invite-business-form";

type SearchState =
  | { status: "idle" }
  | { status: "searching" }
  | { status: "done"; query: string; results: BusinessDirectoryResult[] };

export function DiscoverSearch() {
  const params = useSearchParams();
  // `/discover?invite=1` deep-links straight to the invite form — the hero's
  // "Can't find your cafe? Invite them" link lands here.
  const [inviteOpen, setInviteOpen] = useState(params.get("invite") === "1");
  const [query, setQuery] = useState("");
  const [city, setCity] = useState("");
  const [state, setState] = useState<SearchState>({ status: "idle" });
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  const runSearch = useCallback(
    async (q: string, cityValue: string) => {
      const trimmed = q.trim();
      if (!trimmed) return;

      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setState({ status: "searching" });
      const result = await searchBusinesses(
        { q: trimmed, city: cityValue.trim() || undefined },
        controller.signal,
      ).catch(() => null);

      if (controller.signal.aborted) return;
      if (!result) {
        setState({ status: "idle" });
        return;
      }
      if (!result.ok) {
        setState({ status: "idle" });
        toast.error(result.error);
        return;
      }

      setState({ status: "done", query: trimmed, results: result.businesses });
      // One event per settled search — the form is submit-driven, so this
      // never fires per keystroke. The query string itself is deliberately
      // not sent; see lib/analytics.ts.
      track("PLAYER_DISCOVERY_SEARCH", {
        resultCount: result.businesses.length,
        hadResults: result.businesses.length > 0,
      });
      // A search that finds nothing is the loop's whole reason to exist — open
      // the invite form rather than leaving a dead end.
      if (result.businesses.length === 0) setInviteOpen(true);
    },
    [],
  );

  const noResults = state.status === "done" && state.results.length === 0;

  return (
    <Stack gap={6}>
      <Card>
        <CardHeader>
          <CardTitle>Find a gaming café</CardTitle>
          <CardDescription>
            Search Chrono partners by name, and narrow by city if you like.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void runSearch(query, city);
            }}
          >
            <Stack gap={4}>
              <Field>
                <Label htmlFor="discover-q">Café or business name</Label>
                <Input
                  id="discover-q"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search by name"
                  required
                  data-testid="discover-search-input"
                />
              </Field>
              <Field>
                <Label htmlFor="discover-city">City (optional)</Label>
                <Input
                  id="discover-city"
                  value={city}
                  onChange={(e) => setCity(e.target.value)}
                />
              </Field>
              <Row gap={2} wrap>
                <Button
                  type="submit"
                  disabled={state.status === "searching"}
                  data-testid="discover-search-submit"
                >
                  {state.status === "searching" ? "Searching…" : "Search"}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => setInviteOpen(true)}
                >
                  Invite a business
                </Button>
              </Row>
            </Stack>
          </form>
        </CardContent>
      </Card>

      {state.status === "done" && state.results.length > 0 ? (
        <Stack gap={4} data-testid="discover-results">
          {state.results.map((business) => (
            <BusinessResultCard
              key={business.organizationId}
              business={business}
              onVisit={(organizationId) => track("BUSINESS_VIEW", { organizationId })}
            />
          ))}
        </Stack>
      ) : null}

      {noResults ? (
        <Card data-testid="discover-empty-state">
          <CardHeader>
            <CardTitle>No Chrono partner matched that search</CardTitle>
            <CardDescription>
              They may not be on Chrono yet. You can ask us to bring them here.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : null}

      {inviteOpen ? (
        <InviteBusinessForm
          // Pre-fill with whatever was searched, so the player never retypes it.
          initialBusinessName={state.status === "done" ? state.query : query.trim()}
          onSubmitted={(meta) => track("BUSINESS_INVITE_REQUEST", meta)}
        />
      ) : null}
    </Stack>
  );
}
