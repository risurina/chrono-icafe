import { Row, Stack } from "agora/ui";

/** Shared page-title row for every `/member/*` page — title/description on the
 * left, an optional actions slot (typically a `RefreshButton`) on the right. */
export function MemberPageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
}) {
  return (
    <Row items="center" className="justify-between gap-4">
      <Stack gap={1}>
        <h1 className="text-xl font-semibold tracking-tight md:text-2xl">{title}</h1>
        {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
      </Stack>
      {actions ? <div>{actions}</div> : null}
    </Row>
  );
}
