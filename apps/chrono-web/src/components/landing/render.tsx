import {
  resolveLandingSections,
  type LandingSectionContext,
  type ResolvedLandingConfig,
  type SectionsConfig,
} from "agora";
import { CHRONO_LANDING_SECTIONS } from "./registry";

/**
 * Render a tenant's enabled sections in their configured order.
 *
 * The calling page names no section: it renders whatever the registry and the
 * tenant's stored config agree on. That is what makes the layout configurable
 * rather than hardcoded, and it is the piece the prior-art implementation
 * lacks entirely (its section order is fixed JSX).
 */
export function LandingSections({
  sections,
  resolved,
  context,
  surface,
}: {
  sections: SectionsConfig | null | undefined;
  resolved: ResolvedLandingConfig;
  context: LandingSectionContext;
  surface: "public" | "tenant";
}) {
  const defs = resolveLandingSections(CHRONO_LANDING_SECTIONS, sections, surface);

  return (
    <>
      {defs.map((def) => {
        // `propsFrom` was checked against `Component` at the definition site
        // (see `defineLandingSection`); the map itself is prop-type-erased so
        // it can hold entries with differing prop shapes.
        const Component = def.Component as (props: unknown) => React.ReactNode;
        const props = (
          def.propsFrom as (
            r: ResolvedLandingConfig,
            c: LandingSectionContext,
          ) => unknown
        )(resolved, context);
        return <Component key={def.key} {...(props as object)} />;
      })}
    </>
  );
}
