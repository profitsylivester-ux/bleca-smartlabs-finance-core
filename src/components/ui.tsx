import { cn } from '@/lib/format';

export function Button({
  className,
  variant = 'default',
  size = 'md',
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'default' | 'outline' | 'ghost' | 'danger' | 'link';
  size?: 'sm' | 'md' | 'lg';
}) {
  return (
    <button
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-md font-medium transition-colors',
        'disabled:pointer-events-none disabled:opacity-50',
        variant === 'default' && 'bg-navy-800 hover:bg-navy-700 text-white',
        variant === 'outline' &&
          'border-border-strong text-navy-800 hover:bg-navy-50 border bg-white',
        variant === 'ghost' && 'text-navy-800 hover:bg-navy-50',
        variant === 'danger' && 'bg-negative text-white hover:opacity-90',
        variant === 'link' && 'text-navy-600 hover:text-navy-800 underline underline-offset-4',
        size === 'sm' && 'h-8 px-3 text-xs',
        size === 'md' && 'h-9 px-4 text-sm',
        size === 'lg' && 'h-11 px-6 text-base',
        className,
      )}
      {...props}
    />
  );
}

export function Input({ className, ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        'border-border-strong text-foreground h-9 w-full rounded-md border bg-white px-3 text-sm',
        'placeholder:text-muted-foreground disabled:bg-surface-muted disabled:text-muted-foreground',
        className,
      )}
      {...props}
    />
  );
}

export function Label({ className, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return (
    <label
      className={cn('text-muted-foreground mb-1.5 block text-xs font-medium', className)}
      {...props}
    />
  );
}

export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn('border-border-subtle rounded-lg border bg-white', className)} {...props} />
  );
}

export function CardHeader({
  title,
  description,
  actions,
  className,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'border-border-subtle flex items-start justify-between gap-4 border-b px-5 py-4',
        className,
      )}
    >
      <div className="min-w-0">
        <h2 className="text-foreground text-sm font-semibold">{title}</h2>
        {description ? <p className="text-muted-foreground mt-0.5 text-xs">{description}</p> : null}
      </div>
      {actions ? <div className="shrink-0">{actions}</div> : null}
    </div>
  );
}

export function CardBody({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('px-5 py-4', className)} {...props} />;
}

/**
 * Status pill.
 *
 * Status is carried by the label text, not only by colour, so it remains
 * readable for a colour-blind user and in a printed report.
 */
export function Badge({
  tone = 'neutral',
  children,
  className,
}: {
  tone?: 'neutral' | 'info' | 'success' | 'warning' | 'danger';
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium whitespace-nowrap',
        tone === 'neutral' && 'border-border-strong bg-surface-muted text-muted-foreground',
        tone === 'info' && 'border-navy-200 bg-navy-50 text-navy-800',
        tone === 'success' && 'text-positive border-emerald-200 bg-emerald-50',
        tone === 'warning' && 'text-warning border-amber-200 bg-amber-50',
        tone === 'danger' && 'text-negative border-red-200 bg-red-50',
        className,
      )}
    >
      {children}
    </span>
  );
}

export function Alert({
  tone = 'info',
  title,
  children,
}: {
  tone?: 'info' | 'success' | 'warning' | 'danger';
  title?: string;
  children?: React.ReactNode;
}) {
  return (
    <div
      role={tone === 'danger' ? 'alert' : 'status'}
      className={cn(
        'rounded-md border px-3.5 py-3 text-sm',
        tone === 'info' && 'border-navy-200 bg-navy-50 text-navy-800',
        tone === 'success' && 'text-positive border-emerald-200 bg-emerald-50',
        tone === 'warning' && 'text-warning border-amber-200 bg-amber-50',
        tone === 'danger' && 'text-negative border-red-200 bg-red-50',
      )}
    >
      {title ? <p className="font-medium">{title}</p> : null}
      {children ? (
        <div className={cn(title && 'mt-1', 'text-[13px] leading-relaxed')}>{children}</div>
      ) : null}
    </div>
  );
}

export function Table({ className, ...props }: React.TableHTMLAttributes<HTMLTableElement>) {
  return (
    <div className="w-full overflow-x-auto">
      <table className={cn('w-full border-collapse text-left text-sm', className)} {...props} />
    </div>
  );
}

export function Th({ className, ...props }: React.ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      className={cn(
        'border-border-subtle text-muted-foreground border-b px-3 py-2 text-[11px] font-semibold tracking-wide uppercase',
        className,
      )}
      {...props}
    />
  );
}

export function Td({ className, ...props }: React.TdHTMLAttributes<HTMLTableCellElement>) {
  return (
    <td className={cn('border-border-subtle border-b px-3 py-2 align-top', className)} {...props} />
  );
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div>
        <h1 className="text-foreground text-xl font-semibold tracking-tight">{title}</h1>
        {description ? (
          <p className="text-muted-foreground mt-1 max-w-2xl text-sm">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function EmptyState({ title, body }: { title: string; body?: string }) {
  return (
    <div className="px-5 py-12 text-center">
      <p className="text-foreground text-sm font-medium">{title}</p>
      {body ? <p className="text-muted-foreground mx-auto mt-1 max-w-md text-xs">{body}</p> : null}
    </div>
  );
}
