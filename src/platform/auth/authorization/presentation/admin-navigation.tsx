import { Link } from "@/i18n/navigation";
import { cn } from "@/ui/cn";

/**
 * Navigation for the administration area.
 *
 * The component receives already-translated labels and locale-independent hrefs;
 * the locale prefix comes from the project's locale-aware navigation helper. It
 * makes no authorization decision and holds no business rule: hiding a link is
 * never protection, so every destination enforces access on the server.
 */
export type AdminNavigationItem = Readonly<{
  href: string;
  label: string;
  current: boolean;
}>;

type AdminNavigationProps = Readonly<{
  label: string;
  items: readonly AdminNavigationItem[];
}>;

function AdminNavigation({ label, items }: AdminNavigationProps) {
  return (
    <nav aria-label={label} data-slot="admin-navigation">
      <ul className="flex flex-wrap items-center gap-2">
        {items.map((item) => (
          <li key={item.href}>
            <Link
              href={item.href}
              aria-current={item.current ? "page" : undefined}
              className={cn(
                "inline-flex items-center rounded-md px-3 py-2 text-sm font-medium transition-colors",
                "focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                item.current
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
            >
              {item.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

export { AdminNavigation };
