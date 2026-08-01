import { render, screen, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it } from "vitest";

import type { AuthorizationAuditRecordDto } from "@/platform/auth/authorization/audit/audit-record";
import type { AdminUserDto } from "@/platform/auth/authorization/admin-user-dto";
import {
  ADMIN_SECTION_HREF,
  AdminAreaHeader,
} from "@/platform/auth/authorization/presentation/admin-area-header";
import { AdminAuditList } from "@/platform/auth/authorization/presentation/admin-audit-list";
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

const auditRecords: readonly AuthorizationAuditRecordDto[] = [
  {
    id: "record-1",
    occurredAt: "2026-08-01T10:00:00.000Z",
    action: "identity.user.role-set",
    actorUserId: "actor-1",
    targetUserId: "user-2",
    requestId: null,
    metadata: { role: "admin" },
  },
  {
    id: "record-2",
    occurredAt: "2026-08-01T09:00:00.000Z",
    action: "identity.session.revoked",
    actorUserId: "actor-1",
    targetUserId: "user-2",
    requestId: null,
    metadata: { scope: "all" },
  },
];

const auditListCopy = {
  caption: "Administrative changes, newest first",
  occurredAtHeader: "When",
  actionHeader: "Action",
  actorHeader: "Actor",
  targetHeader: "Target",
  detailHeader: "Detail",
  noDetail: "—",
  emptyTitle: "No records yet",
  emptyDescription: "A record appears after a change completes.",
};

const actionLabels = {
  "identity.user.role-set": "Role changed",
  "identity.session.revoked": "Sessions revoked",
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
  it("renders one row per record with a translated action", () => {
    const { container } = renderInDirection(
      "ltr",
      <AdminAuditList
        records={auditRecords}
        copy={auditListCopy}
        actionLabels={actionLabels}
        formatDetail={(record) =>
          "role" in (record.metadata ?? {}) ? "New role: admin" : "All sessions"
        }
        formatDateTime={(isoDate) => isoDate.slice(0, 16)}
      />,
    );

    const rows = slots(container, "admin-audit-row");

    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveAttribute("data-action", "identity.user.role-set");
    expect(rows[0]).toHaveTextContent("Role changed");
    expect(rows[1]).toHaveTextContent("Sessions revoked");
  });

  it("renders a placeholder when a record carries no detail", () => {
    renderInDirection(
      "ltr",
      <AdminAuditList
        records={[{ ...auditRecords[0], metadata: null }]}
        copy={auditListCopy}
        actionLabels={actionLabels}
        formatDetail={() => null}
        formatDateTime={(isoDate) => isoDate}
      />,
    );

    expect(screen.getByText(auditListCopy.noDetail)).toBeInTheDocument();
  });

  it("renders no session identifier and no sensitive field", () => {
    const { container } = renderInDirection(
      "rtl",
      <AdminAuditList
        records={auditRecords}
        copy={auditListCopy}
        actionLabels={{
          "identity.user.role-set": "تغيير الدور",
          "identity.session.revoked": "إبطال الجلسات",
        }}
        formatDetail={() => "جميع الجلسات"}
        formatDateTime={(isoDate) => isoDate}
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

  it("renders an empty state before any change is recorded", () => {
    renderInDirection(
      "ltr",
      <AdminAuditList
        records={[]}
        copy={auditListCopy}
        actionLabels={actionLabels}
        formatDetail={() => null}
        formatDateTime={(isoDate) => isoDate}
      />,
    );

    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.getByText(auditListCopy.emptyTitle)).toBeInTheDocument();
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
