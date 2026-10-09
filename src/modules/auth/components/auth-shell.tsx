import Link from 'next/link';
import { Alert } from '@/components/ui';

export function AuthShell({
  title,
  description,
  children,
  footer,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <main className="bg-navy-900 flex min-h-screen items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-lg bg-white/10 ring-1 ring-white/20">
            <span className="text-lg font-semibold text-white">B</span>
          </div>
          <h1 className="text-lg font-semibold text-white">{title}</h1>
          <p className="text-navy-200 mt-1 text-sm">{description}</p>
        </div>

        <div className="border-navy-700 rounded-xl border bg-white p-6 shadow-xl">{children}</div>

        {footer ? <div className="text-navy-200 mt-4 text-center text-xs">{footer}</div> : null}
      </div>
    </main>
  );
}

export function AuthErrorBanner({ message }: { message?: string | null }) {
  if (!message) return null;
  return (
    <div className="mb-4">
      <Alert tone="danger">{message}</Alert>
    </div>
  );
}

export function AuthFooterLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link href={href} className="text-navy-600 hover:text-navy-800 underline underline-offset-4">
      {children}
    </Link>
  );
}
