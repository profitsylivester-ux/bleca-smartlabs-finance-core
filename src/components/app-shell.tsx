'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import { Badge, Button } from '@/components/ui';
import { cn } from '@/lib/format';
import { logoutAction } from '@/modules/auth/server/actions';
import type { ModuleDefinition } from '@/modules/module-registry';

interface Group {
  key: string;
  label: string;
  modules: ModuleDefinition[];
}

const ICONS: Record<string, string> = {
  gauge: 'M3 13h4v6H3zM10 6h4v13h-4zM17 10h4v9h-4z',
  users:
    'M8 11a3 3 0 100-6 3 3 0 000 6zM2 20a6 6 0 0112 0M17 11a3 3 0 100-6M16 20h6a5 5 0 00-4-4.9',
  'scroll-text': 'M6 3h9l4 4v14H6zM9 8h7M9 12h7M9 16h4',
  'list-tree': 'M4 5h4v4H4zM4 15h4v4H4zM14 7h7M14 17h7',
  'book-open': 'M4 5a3 3 0 013-3h13v16H7a3 3 0 00-3 3zM20 18a3 3 0 00-3 3H4',
  'arrow-left-right': 'M8 7L4 11l4 4M4 11h16M16 7l4 4-4 4',
  'check-square': 'M4 4h16v16H4zM8 12l3 3 5-6',
  target: 'M12 3v3M12 18v3M3 12h3M18 12h3M12 8a4 4 0 100 8 4 4 0 000-8z',
  wallet: 'M3 7h15a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2zM3 7V5a1 1 0 011-1h12v3M16 13h2',
  scale: 'M12 4v16M6 8l-3 6h6zM18 8l-3 6h6zM6 8h12M4 20h16',
  truck:
    'M3 7h11v9H3zM14 10h4l3 3v3h-7zM7 19a2 2 0 100-4 2 2 0 000 4zM18 19a2 2 0 100-4 2 2 0 000 4z',
  receipt: 'M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6M9 16h3',
  folder: 'M3 6h6l2 2h10v11H3z',
  landmark: 'M12 3l9 5H3zM6 11v6M10 11v6M14 11v6M18 11v6M4 20h16',
  'file-chart': 'M6 3h8l4 4v14H6zM9 13h6M9 17h4',
  bell: 'M6 9a6 6 0 1112 0c0 5 2 6 2 6H4s2-1 2-6M10 20a2 2 0 004 0',
};

function NavIcon({ name }: { name: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-4 w-4 shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={ICONS[name] ?? ICONS.gauge} />
    </svg>
  );
}

export function AppShell({
  actor,
  unreadNotifications,
  groups,
  grantedKeys,
  children,
}: {
  actor: { fullName: string; email: string; roleCodes: string[]; isFinalApprover: boolean };
  unreadNotifications: number;
  groups: Group[];
  grantedKeys: Set<string>;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  return (
    <div className="min-h-screen lg:flex">
      {/* Mobile bar */}
      <div className="border-navy-800 bg-navy-900 flex items-center justify-between border-b px-4 py-3 lg:hidden">
        <span className="text-sm font-semibold text-white">BLECA SmartLabs Finance</span>
        <Button
          variant="ghost"
          size="sm"
          className="text-white hover:bg-white/10"
          onClick={() => setOpen(!open)}
        >
          {open ? 'Close' : 'Menu'}
        </Button>
      </div>

      <aside
        className={cn(
          'border-navy-800 bg-navy-900 shrink-0 border-r lg:flex lg:w-64 lg:flex-col',
          open ? 'block' : 'hidden',
        )}
      >
        <div className="hidden items-center gap-2.5 px-5 py-5 lg:flex">
          <div className="flex h-8 w-8 items-center justify-center rounded-md bg-white/10 ring-1 ring-white/20">
            <span className="text-sm font-semibold text-white">B</span>
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-white">BLECA SmartLabs</p>
            <p className="text-navy-300 truncate text-[11px]">Finance</p>
          </div>
        </div>

        <nav className="flex-1 space-y-5 overflow-y-auto px-3 pb-6">
          {groups.map((group) => {
            const visible = group.modules.filter(
              (m) => m.availability === 'AVAILABLE' && grantedKeys.has(m.key),
            );
            const planned = group.modules.filter((m) => m.availability === 'PLANNED');

            if (visible.length === 0 && planned.length === 0) return null;

            return (
              <div key={group.key}>
                <p className="text-navy-400 px-2 pb-1.5 text-[10px] font-semibold tracking-wider uppercase">
                  {group.label}
                </p>
                <ul className="space-y-0.5">
                  {visible.map((module) => {
                    const active =
                      module.path !== null &&
                      (pathname === module.path || pathname.startsWith(`${module.path}/`));
                    return (
                      <li key={module.key}>
                        <Link
                          href={module.path ?? '#'}
                          className={cn(
                            'flex items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px]',
                            active
                              ? 'bg-navy-700 font-medium text-white'
                              : 'text-navy-200 hover:bg-navy-800 hover:text-white',
                          )}
                        >
                          <NavIcon name={module.icon} />
                          <span className="truncate">{module.label}</span>
                        </Link>
                      </li>
                    );
                  })}

                  {/*
                    Planned modules are listed but not linked. Showing them makes
                    the phase boundary visible to the people who have to work
                    inside it, instead of leaving them to infer it from a module
                    that simply is not in the menu.
                  */}
                  {planned.length > 0 ? (
                    <li className="pt-1">
                      <details className="group">
                        <summary className="text-navy-400 hover:text-navy-200 cursor-pointer list-none px-2 py-1 text-[11px]">
                          {planned.length} planned
                        </summary>
                        <ul className="border-navy-800 mt-0.5 space-y-0.5 border-l pl-3">
                          {planned.map((module) => (
                            <li
                              key={module.key}
                              className="text-navy-400 flex items-center gap-2 rounded-md px-2 py-1 text-[12px]"
                              title={module.description}
                            >
                              <NavIcon name={module.icon} />
                              <span className="truncate">{module.label}</span>
                              <Badge tone="neutral" className="ml-auto">
                                {module.milestone}
                              </Badge>
                            </li>
                          ))}
                        </ul>
                      </details>
                    </li>
                  ) : null}
                </ul>
              </div>
            );
          })}
        </nav>

        <div className="border-navy-800 border-t px-4 py-3">
          <p className="truncate text-[13px] font-medium text-white">{actor.fullName}</p>
          <p className="text-navy-300 truncate text-[11px]">{actor.email}</p>
          <div className="mt-1.5 flex flex-wrap gap-1">
            {actor.roleCodes.map((code) => (
              <Badge key={code} tone="info" className="border-navy-600 bg-navy-800 text-navy-200">
                {code}
              </Badge>
            ))}
          </div>
          <form action={logoutAction} className="mt-3">
            <button
              type="submit"
              className="text-navy-300 text-[12px] underline underline-offset-4 hover:text-white"
            >
              Sign out
            </button>
          </form>
        </div>
      </aside>

      <div className="min-w-0 flex-1">
        <header className="border-border-subtle flex items-center justify-end gap-3 border-b bg-white px-6 py-2.5">
          <span className="text-muted-foreground relative inline-flex items-center gap-1.5 text-[13px]">
            <NavIcon name="bell" />
            Notifications
            {unreadNotifications > 0 ? (
              <Badge tone="info">{unreadNotifications}</Badge>
            ) : (
              <span className="text-muted-foreground text-[11px]">(M16)</span>
            )}
          </span>
        </header>
        <main className="px-6 py-6">{children}</main>
      </div>
    </div>
  );
}
