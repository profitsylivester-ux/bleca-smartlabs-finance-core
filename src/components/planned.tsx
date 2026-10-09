import { Card, CardBody, CardHeader, Badge } from '@/components/ui';

/**
 * A panel that names what is coming and when.
 *
 * Deliberately not a spinner and not an empty state. Every figure on a finance
 * dashboard means something, and showing an empty chart for a metric that does
 * not exist yet is a way of telling the CEO that revenue is zero.
 */
export function PlannedPanel({
  title,
  description,
  items,
  milestone,
}: {
  title: string;
  description: string;
  items: string[];
  milestone: string;
}) {
  return (
    <Card>
      <CardHeader
        title={title}
        description={description}
        actions={<Badge tone="neutral">{milestone}</Badge>}
      />
      <CardBody>
        <ul className="space-y-2">
          {items.map((item) => (
            <li key={item} className="text-muted-foreground flex items-start gap-2.5 text-sm">
              <span
                aria-hidden="true"
                className="bg-navy-300 mt-1.5 h-1 w-1 shrink-0 rounded-full"
              />
              <span>{item}</span>
            </li>
          ))}
        </ul>
      </CardBody>
    </Card>
  );
}

export function StatTile({
  label,
  value,
  hint,
  unavailable,
}: {
  label: string;
  value?: string;
  hint?: string;
  unavailable?: string;
}) {
  return (
    <div className="border-border-subtle rounded-lg border bg-white px-4 py-3">
      <p className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">
        {label}
      </p>
      {unavailable ? (
        <p className="text-muted-foreground mt-1.5 text-sm">
          {unavailable}
          <span className="text-navy-400 ml-1.5 text-[11px]">{hint}</span>
        </p>
      ) : (
        <p className="tabular text-foreground mt-1.5 text-xl font-semibold">{value}</p>
      )}
      {hint && !unavailable ? (
        <p className="text-muted-foreground mt-0.5 text-[11px]">{hint}</p>
      ) : null}
    </div>
  );
}
