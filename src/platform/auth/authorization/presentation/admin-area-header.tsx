import { AdminNavigation } from "./admin-navigation";

/**
 * The heading and navigation shared by every administration page.
 *
 * The area's layout owns authorization; this component owns presentation only.
 * Each page states which section it is, so the navigation can mark the current
 * destination for assistive technology.
 */
export const ADMIN_SECTIONS = ["dashboard", "users", "audit"] as const;

export type AdminSection = (typeof ADMIN_SECTIONS)[number];

/** Locale-independent hrefs; the locale prefix is added by the Link helper. */
export const ADMIN_SECTION_HREF = {
  dashboard: "/admin",
  users: "/admin/users",
  audit: "/admin/audit",
} as const satisfies Readonly<Record<AdminSection, string>>;

type AdminAreaHeaderProps = Readonly<{
  title: string;
  description: string;
  navigationLabel: string;
  sectionLabels: Readonly<Record<AdminSection, string>>;
  current: AdminSection;
}>;

function AdminAreaHeader({
  title,
  description,
  navigationLabel,
  sectionLabels,
  current,
}: AdminAreaHeaderProps) {
  return (
    <header className="flex flex-col gap-4" data-slot="admin-area-header">
      <AdminNavigation
        label={navigationLabel}
        items={ADMIN_SECTIONS.map((section) => ({
          href: ADMIN_SECTION_HREF[section],
          label: sectionLabels[section],
          current: section === current,
        }))}
      />
      <div className="flex flex-col gap-1">
        <h1 className="text-heading-lg font-bold tracking-tight">{title}</h1>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
    </header>
  );
}

export { AdminAreaHeader };
