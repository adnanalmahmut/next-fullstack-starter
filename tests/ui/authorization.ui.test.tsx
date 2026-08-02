import { render, screen, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it } from "vitest";

import type { AuditRecordDto } from "@/platform/audit/index.server";
import { AdminAuditList } from "@/platform/audit/presentation/admin-audit-list";
import type { AdminUserDto } from "@/platform/auth/authorization/admin-user-dto";
import {
  ADMIN_SECTION_HREF,
  AdminAreaHeader,
} from "@/platform/auth/authorization/presentation/admin-area-header";
import { AdminUserList } from "@/platform/auth/authorization/presentation/admin-user-list";
import { StatusState } from "@/ui/patterns/status-state";

const arabicCopy = {
  navigationLabel: "الإدارة",
  sections: {
    dashboard: "نظرة عامة",
    users: "المستخدمون",
    audit: "سجل التدقيق",
  },
};

const englishCopy = {
  navigationLabel: "Administration",
  sections: {
    dashboard: "Overview",
    users: "Users",
    audit: "Audit trail",
  },
};

const users: readonly AdminUserDto[] = [
  {
    id: "user-1",
    name: "Sara Person",
    email: "sara@example.test",
    emailVerified: true,
    roles: ["admin"],
    createdAt: "2026-08-01T09:00:00.000Z",
  },
  {
    id: "user-2",
    name: "Omar Person",
    email: "omar@example.test",
    emailVerified: false,
    roles: [],
    createdAt: "2026-07-30T09:00:00.000Z",
  },
];

const userListCopy = {
  caption: "Users, newest first",
  nameHeader: "Name",
  emailHeader: "Email address",
  rolesHeader: "Roles",
  createdAtHeader: "Created",
  noRole: "Default",
  emptyTitle: "No users to show",
  emptyDescription: "No user matches the current page.",
  total: "2 users in total",
};

const auditRecords: readonly AuditRecordDto[] = [
  {
    id: "record-1",
    occurredAt: "2026-08-01T10:00:00.000Z",
    actor: { type: "user", id: "actor-1" },
    action: "identity.user.role-set",
    resource: { type: "identity.user", id: "user-2" },
    result: "succeeded",
    requestId: null,
    metadata: { role: "admin" },
  },
  {
    id: "record-2",
    occurredAt: "2026-08-01T09:00:00.000Z",
    actor: { type: "user", id: "actor-1" },
    action: "identity.session.revoked",
    resource: { type: "identity.user", id: "user-2" },
    result: "succeeded",
    requestId: null,
    metadata: { scope: "all" },
  },
];

const auditListCopy = {
  caption: "Administrative changes, newest first",
  occurredAtHeader: "When",
  actionHeader: "Action",
  actorHeader: "Actor",
  resourceHeader: "Resource",
  resultHeader: "Result",
  detailHeader: "Detail",
  noDetail: "—",
  emptyTitle: "No records yet",
  emptyDescription: "A record appears after a change completes.",
  paginationLabel: "Audit trail pagination",
};

const actionLabels = {
  "identity.user.role-set": "Role changed",
  "identity.session.revoked": "Sessions revoked",
};

const actorTypeLabels = { user: "User", system: "System" };

/** Built at run time so the Next.js page-link rule sees no static route. */
const nextPageHref = ["", "en", "admin", "audit"].join("/") + "?cursor=next";

const resultLabels = {
  succeeded: "Succeeded",
  failed: "Failed",
  denied: "Denied",
};

/**
 * The locale-aware navigation helper reads the active locale from the intl
 * context, exactly as it does inside the application shell.
 */
function renderInDirection(direction: "rtl" | "ltr", node: React.ReactNode) {
  return render(
    <NextIntlClientProvider locale={direction === "rtl" ? "ar" : "en"}>
      <div dir={direction}>{node}</div>
    </NextIntlClientProvider>,
  );
}

/** The project marks presentation regions with `data-slot`, not a test id. */
function slots(container: HTMLElement, slot: string): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(`[data-slot="${slot}"]`)];
}

function slot(container: HTMLElement, name: string): HTMLElement {
  const [element] = slots(container, name);

  if (!element) {
    throw new Error(`No element with data-slot="${name}"`);
  }

  return element;
}

describe("AdminAreaHeader", () => {
  it("renders accessible navigation and a single first-level heading in Arabic", () => {
    renderInDirection(
      "rtl",
      <AdminAreaHeader
        current="users"
        title="المستخدمون"
        description="قائمة محدودة تبدأ بالأحدث."
        navigationLabel={arabicCopy.navigationLabel}
        sectionLabels={arabicCopy.sections}
      />,
    );

    const navigation = screen.getByRole("navigation", {
      name: arabicCopy.navigationLabel,
    });

    expect(navigation).toBeInTheDocument();
    expect(within(navigation).getAllByRole("link")).toHaveLength(3);
    expect(
      screen.getByRole("heading", { level: 1, name: "المستخدمون" }),
    ).toBeInTheDocument();
  });

  it("renders the same structure in English", () => {
    renderInDirection(
      "ltr",
      <AdminAreaHeader
        current="dashboard"
        title="Administration"
        description="Every request is authorized on the server."
        navigationLabel={englishCopy.navigationLabel}
        sectionLabels={englishCopy.sections}
      />,
    );

    expect(
      screen.getByRole("navigation", { name: englishCopy.navigationLabel }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 1, name: "Administration" }),
    ).toBeInTheDocument();
  });

  it("marks only the current section for assistive technology", () => {
    renderInDirection(
      "ltr",
      <AdminAreaHeader
        current="audit"
        title="Audit trail"
        description="Newest first."
        navigationLabel={englishCopy.navigationLabel}
        sectionLabels={englishCopy.sections}
      />,
    );

    const current = screen.getByRole("link", {
      name: englishCopy.sections.audit,
    });

    expect(current).toHaveAttribute("aria-current", "page");
    expect(
      screen.getByRole("link", { name: englishCopy.sections.users }),
    ).not.toHaveAttribute("aria-current");
  });

  it("keeps the section hrefs locale independent", () => {
    expect(ADMIN_SECTION_HREF).toEqual({
      dashboard: "/admin",
      users: "/admin/users",
      audit: "/admin/audit",
    });
  });
});

describe("AdminUserList", () => {
  it("renders a captioned table with a row header per user", () => {
    renderInDirection(
      "ltr",
      <AdminUserList
        users={users}
        copy={userListCopy}
        roleLabels={{ admin: "Administrator", user: "User" }}
        formatDate={(isoDate) => isoDate.slice(0, 10)}
      />,
    );

    const table = screen.getByRole("table", { name: userListCopy.caption });

    expect(table).toBeInTheDocument();
    expect(within(table).getAllByRole("columnheader")).toHaveLength(4);
    expect(within(table).getAllByRole("rowheader")).toHaveLength(2);
    expect(
      within(table).getByRole("rowheader", { name: "Sara Person" }),
    ).toBeInTheDocument();
  });

  it("translates a role and falls back to the stored value", () => {
    const { container } = renderInDirection(
      "ltr",
      <AdminUserList
        users={[
          ...users,
          {
            id: "user-3",
            name: "Unknown Role",
            email: "unknown@example.test",
            emailVerified: false,
            roles: ["superadmin"],
            createdAt: "2026-07-01T09:00:00.000Z",
          },
        ]}
        copy={userListCopy}
        roleLabels={{ admin: "Administrator", user: "User" }}
        formatDate={(isoDate) => isoDate.slice(0, 10)}
      />,
    );

    const roleCells = slots(container, "admin-user-roles");

    expect(roleCells[0]).toHaveTextContent("Administrator");
    expect(roleCells[1]).toHaveTextContent(userListCopy.noRole);
    expect(roleCells[2]).toHaveTextContent("superadmin");
  });

  it("keeps an email address readable in a right-to-left layout", () => {
    const { container } = renderInDirection(
      "rtl",
      <AdminUserList
        users={users}
        copy={userListCopy}
        roleLabels={{ admin: "مدير", user: "مستخدم" }}
        formatDate={(isoDate) => isoDate.slice(0, 10)}
      />,
    );

    expect(
      container.querySelector('[data-slot="admin-user-row"] [dir="ltr"]'),
    ).toHaveTextContent("sara@example.test");
  });

  it("renders no credential, token, or ban field", () => {
    const { container } = renderInDirection(
      "ltr",
      <AdminUserList
        users={users}
        copy={userListCopy}
        roleLabels={{ admin: "Administrator", user: "User" }}
        formatDate={(isoDate) => isoDate.slice(0, 10)}
      />,
    );
    const markup = container.innerHTML;

    for (const field of [
      "password",
      "token",
      "banned",
      "banReason",
      "ipAddress",
      "userAgent",
    ]) {
      expect(markup.includes(field), field).toBe(false);
    }
  });

  it("renders an empty state instead of an empty table", () => {
    renderInDirection(
      "ltr",
      <AdminUserList
        users={[]}
        copy={userListCopy}
        roleLabels={{}}
        formatDate={(isoDate) => isoDate}
      />,
    );

    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.getByText(userListCopy.emptyTitle)).toBeInTheDocument();
    expect(screen.getByText(userListCopy.emptyDescription)).toBeInTheDocument();
  });

  it("uses no physical alignment utility", () => {
    const { container } = renderInDirection(
      "rtl",
      <AdminUserList
        users={users}
        copy={userListCopy}
        roleLabels={{}}
        formatDate={(isoDate) => isoDate}
      />,
    );

    expect(container.innerHTML).not.toMatch(/\btext-(?:left|right)\b/);
    expect(container.innerHTML).toContain("text-start");
  });
});

describe("AdminAuditList", () => {
  const baseProps = {
    copy: auditListCopy,
    actionLabels,
    actorTypeLabels,
    resultLabels,
    formatDateTime: (isoDate: string) => isoDate.slice(0, 16),
  };

  it.each(["ltr", "rtl"] as const)(
    "renders one row per record with generic columns in %s",
    (direction) => {
      const { container } = renderInDirection(
        direction,
        <AdminAuditList
          {...baseProps}
          records={auditRecords}
          formatDetail={(record) =>
            "role" in (record.metadata ?? {})
              ? "New role: admin"
              : "All sessions"
          }
        />,
      );

      const rows = slots(container, "admin-audit-row");

      expect(rows).toHaveLength(2);
      expect(rows[0]).toHaveAttribute("data-action", "identity.user.role-set");
      expect(rows[0]).toHaveAttribute("data-result", "succeeded");
      expect(rows[0]).toHaveTextContent("Role changed");
      expect(rows[0]).toHaveTextContent("User");
      expect(rows[0]).toHaveTextContent("actor-1");
      expect(rows[0]).toHaveTextContent("identity.user");
      expect(rows[0]).toHaveTextContent("user-2");
      expect(rows[0]).toHaveTextContent("Succeeded");
      expect(rows[0]).toHaveTextContent("New role: admin");
      expect(rows[1]).toHaveTextContent("Sessions revoked");
      expect(rows[1]).toHaveTextContent("All sessions");
    },
  );

  it("is a semantic table with a caption and a header row", () => {
    const { container } = renderInDirection(
      "ltr",
      <AdminAuditList
        {...baseProps}
        records={auditRecords}
        formatDetail={() => null}
      />,
    );

    const table = screen.getByRole("table");

    expect(within(table).getByText(auditListCopy.caption)).toBeInTheDocument();
    expect(
      slots(container, "admin-audit-list")[0]?.querySelector("caption"),
    ).not.toBeNull();

    for (const header of [
      auditListCopy.occurredAtHeader,
      auditListCopy.actionHeader,
      auditListCopy.actorHeader,
      auditListCopy.resourceHeader,
      auditListCopy.resultHeader,
      auditListCopy.detailHeader,
    ]) {
      expect(within(table).getByText(header)).toBeInTheDocument();
    }
  });

  it("renders every identifier left to right", () => {
    const { container } = renderInDirection(
      "rtl",
      <AdminAuditList
        {...baseProps}
        records={auditRecords}
        formatDetail={() => null}
      />,
    );

    const rows = slots(container, "admin-audit-row");
    const identifiers = [...rows[0].querySelectorAll('[dir="ltr"]')].map(
      (element) => element.textContent,
    );

    expect(identifiers).toContain("actor-1");
    expect(identifiers).toContain("user-2");
    expect(identifiers).toContain("identity.user");
  });

  it("falls back to the stable name for an action it has no label for", () => {
    const { container } = renderInDirection(
      "ltr",
      <AdminAuditList
        {...baseProps}
        records={[
          {
            ...auditRecords[0],
            action: "documents.document.published",
            resource: { type: "documents.document", id: "doc-1" },
            metadata: null,
          },
        ]}
        formatDetail={() => null}
      />,
    );

    const row = slots(container, "admin-audit-row")[0];

    expect(row).toHaveTextContent("documents.document.published");
    expect(row).toHaveTextContent("documents.document");
    expect(row).toHaveTextContent(auditListCopy.noDetail);
  });

  it("renders a placeholder when a record carries no detail", () => {
    renderInDirection(
      "ltr",
      <AdminAuditList
        {...baseProps}
        records={[{ ...auditRecords[0], metadata: null }]}
        formatDetail={() => null}
      />,
    );

    expect(screen.getByText(auditListCopy.noDetail)).toBeInTheDocument();
  });

  it("shows no detail when the stored metadata was withheld", () => {
    // The platform answers `null` for metadata it could not re-validate, so the
    // record is still listed and the detail column is simply empty.
    const { container } = renderInDirection(
      "ltr",
      <AdminAuditList
        {...baseProps}
        records={[{ ...auditRecords[0], metadata: null }]}
        formatDetail={(record) =>
          record.metadata === null ? null : "New role: admin"
        }
      />,
    );

    expect(slots(container, "admin-audit-row")).toHaveLength(1);
    expect(screen.getByText(auditListCopy.noDetail)).toBeInTheDocument();
  });

  it("renders no session identifier and no sensitive field", () => {
    const { container } = renderInDirection(
      "rtl",
      <AdminAuditList
        {...baseProps}
        records={auditRecords}
        actionLabels={{
          "identity.user.role-set": "تغيير الدور",
          "identity.session.revoked": "إبطال الجلسات",
        }}
        formatDetail={() => "جميع الجلسات"}
      />,
    );
    const markup = container.innerHTML;

    for (const field of [
      "actorSessionId",
      "sessionToken",
      "password",
      "cookie",
      "ipAddress",
      "userAgent",
    ]) {
      expect(markup.includes(field), field).toBe(false);
    }
  });

  it("renders no raw metadata object", () => {
    const { container } = renderInDirection(
      "ltr",
      <AdminAuditList
        {...baseProps}
        records={auditRecords}
        formatDetail={() => "New role: admin"}
      />,
    );

    expect(container.innerHTML).not.toContain('{"role"');
    expect(container.innerHTML).not.toContain("&quot;role&quot;");
  });

  it("offers no export, delete, or edit control", () => {
    const { container } = renderInDirection(
      "ltr",
      <AdminAuditList
        {...baseProps}
        records={auditRecords}
        formatDetail={() => null}
      />,
    );

    expect(container.querySelectorAll("button")).toHaveLength(0);
    expect(container.querySelectorAll("form")).toHaveLength(0);
  });

  it("shows the next-page control only when one was supplied", () => {
    const withoutNext = renderInDirection(
      "ltr",
      <AdminAuditList
        {...baseProps}
        records={auditRecords}
        formatDetail={() => null}
      />,
    );

    expect(slots(withoutNext.container, "admin-audit-pagination")).toHaveLength(
      0,
    );

    withoutNext.unmount();

    const withNext = renderInDirection(
      "ltr",
      <AdminAuditList
        {...baseProps}
        records={auditRecords}
        formatDetail={() => null}
        nextPageLink={
          // A plain anchor stands in for the locale-aware link the page
          // supplies: the component takes a node, so it never learns about
          // routing. `data-slot` keeps the assertion off the href shape.
          <a data-slot="admin-audit-next-page" href={nextPageHref}>
            Next page
          </a>
        }
      />,
    );

    const navigation = slot(withNext.container, "admin-audit-pagination");

    expect(navigation).toHaveAttribute(
      "aria-label",
      auditListCopy.paginationLabel,
    );
    expect(within(navigation).getByRole("link")).toHaveAttribute(
      "href",
      nextPageHref,
    );
  });

  it("renders an empty state before any change is recorded", () => {
    renderInDirection(
      "ltr",
      <AdminAuditList {...baseProps} records={[]} formatDetail={() => null} />,
    );

    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.getByText(auditListCopy.emptyTitle)).toBeInTheDocument();
    expect(
      screen.getByText(auditListCopy.emptyDescription),
    ).toBeInTheDocument();
  });

  it("uses no physical alignment utility", () => {
    const { container } = renderInDirection(
      "rtl",
      <AdminAuditList
        {...baseProps}
        records={auditRecords}
        formatDetail={() => null}
      />,
    );

    expect(container.innerHTML).not.toMatch(/\btext-(?:left|right)\b/);
    expect(container.innerHTML).toContain("text-start");
  });
});

describe("denied state", () => {
  it.each([
    {
      direction: "rtl" as const,
      title: "الوصول مقيَّد",
      description: "صلاحياتك الحالية لا تتضمن منطقة الإدارة.",
    },
    {
      direction: "ltr" as const,
      title: "Access is restricted",
      description: "Your current access does not include the area.",
    },
  ])(
    "renders the forbidden state in $direction",
    ({ direction, title, description }) => {
      const { container } = renderInDirection(
        direction,
        <StatusState
          data-slot="admin-forbidden"
          status="forbidden"
          title={title}
          description={description}
        />,
      );

      const state = slot(container, "admin-forbidden");

      expect(state).toHaveAttribute("data-status", "forbidden");
      expect(state).toHaveTextContent(title);
      expect(state).toHaveTextContent(description);
    },
  );
});
