import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const replace = vi.fn();
const refresh = vi.fn();
const signInEmail = vi.fn();
const signOut = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, refresh }),
}));

vi.mock("@/platform/auth/auth-client", () => ({
  signIn: {
    email: (...args: unknown[]) => signInEmail(...args),
  },
  signOut: (...args: unknown[]) => signOut(...args),
}));

const { LoginForm } = await import("@/platform/auth/presentation/login-form");
const { LogoutButton } =
  await import("@/platform/auth/presentation/logout-button");

const loginCopy = {
  emailLabel: "Email address",
  emailPlaceholder: "name@example.com",
  passwordLabel: "Password",
  submit: "Sign in",
  submitting: "Signing in",
  errorTitle: "Unable to sign in",
  invalidCredentials: "The email address or password is incorrect.",
  unexpectedError: "Something went wrong. Please try again.",
};

const logoutCopy = {
  logout: "Sign out",
  loggingOut: "Signing out",
  logoutError: "Unable to sign out. Please try again.",
};

function renderLoginForm(returnTo = "/en/account") {
  return render(<LoginForm copy={loginCopy} returnTo={returnTo} />);
}

async function fillCredentials(
  user: ReturnType<typeof userEvent.setup>,
  password = "ui-test-only-password",
) {
  await user.type(
    screen.getByLabelText(loginCopy.emailLabel),
    "u@example.test",
  );
  await user.type(screen.getByLabelText(loginCopy.passwordLabel), password);
}

beforeEach(() => {
  replace.mockReset();
  refresh.mockReset();
  signInEmail.mockReset();
  signOut.mockReset();
});

describe("LoginForm", () => {
  it("labels both credential inputs and declares autofill hints", () => {
    renderLoginForm();

    const email = screen.getByLabelText(loginCopy.emailLabel);
    const password = screen.getByLabelText(loginCopy.passwordLabel);

    expect(email).toHaveAttribute("type", "email");
    expect(email).toHaveAttribute("autocomplete", "email");
    expect(password).toHaveAttribute("type", "password");
    expect(password).toHaveAttribute("autocomplete", "current-password");
  });

  it("keeps credential inputs left-to-right inside a right-to-left page", () => {
    document.documentElement.setAttribute("dir", "rtl");

    renderLoginForm("/ar/account");

    expect(screen.getByLabelText(loginCopy.emailLabel)).toHaveAttribute(
      "dir",
      "ltr",
    );
    expect(screen.getByLabelText(loginCopy.passwordLabel)).toHaveAttribute(
      "dir",
      "ltr",
    );
  });

  it("navigates to the provided return path after a successful sign-in", async () => {
    const user = userEvent.setup();

    signInEmail.mockResolvedValue({ error: null });

    renderLoginForm("/ar/account");
    await fillCredentials(user);
    await user.click(screen.getByRole("button", { name: loginCopy.submit }));

    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith("/ar/account");
    });

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(signInEmail).toHaveBeenCalledWith({
      email: "u@example.test",
      password: "ui-test-only-password",
    });
  });

  it("shows a generic message and keeps the form usable after a rejection", async () => {
    const user = userEvent.setup();

    signInEmail.mockResolvedValue({
      error: { message: "User with this email was not found", code: "X" },
    });

    renderLoginForm();
    await fillCredentials(user);
    await user.click(screen.getByRole("button", { name: loginCopy.submit }));

    const alert = await screen.findByRole("alert");

    expect(alert).toHaveTextContent(loginCopy.invalidCredentials);
    expect(alert).not.toHaveTextContent("was not found");
    expect(replace).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: loginCopy.submit }),
    ).toBeEnabled();
  });

  it("reports an unexpected failure without provider detail", async () => {
    const user = userEvent.setup();

    signInEmail.mockRejectedValue(new Error("connection reset by peer"));

    renderLoginForm();
    await fillCredentials(user);
    await user.click(screen.getByRole("button", { name: loginCopy.submit }));

    const alert = await screen.findByRole("alert");

    expect(alert).toHaveTextContent(loginCopy.unexpectedError);
    expect(alert).not.toHaveTextContent("connection reset");
  });

  it("prevents a duplicate submission while a request is pending", async () => {
    const user = userEvent.setup();
    let resolveSignIn: (value: { error: null }) => void = () => {};

    signInEmail.mockImplementation(
      () =>
        new Promise<{ error: null }>((resolve) => {
          resolveSignIn = resolve;
        }),
    );

    renderLoginForm();
    await fillCredentials(user);

    const submit = screen.getByRole("button", { name: loginCopy.submit });

    await user.click(submit);

    const pending = await screen.findByRole("button", {
      name: new RegExp(loginCopy.submitting),
    });

    expect(pending).toBeDisabled();

    await user.click(pending);

    expect(signInEmail).toHaveBeenCalledTimes(1);

    resolveSignIn({ error: null });

    await waitFor(() => {
      expect(replace).toHaveBeenCalledTimes(1);
    });
  });

  it("submits from the keyboard", async () => {
    const user = userEvent.setup();

    signInEmail.mockResolvedValue({ error: null });

    renderLoginForm();
    await fillCredentials(user);
    await user.keyboard("{Enter}");

    await waitFor(() => {
      expect(signInEmail).toHaveBeenCalledTimes(1);
    });
  });
});

describe("LogoutButton", () => {
  it("signs out and navigates to the localized login path", async () => {
    const user = userEvent.setup();

    signOut.mockResolvedValue({ error: null });

    render(<LogoutButton copy={logoutCopy} loginPath="/ar/login" />);
    await user.click(screen.getByRole("button", { name: logoutCopy.logout }));

    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith("/ar/login");
    });

    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("shows pending state and prevents a duplicate request", async () => {
    const user = userEvent.setup();
    let resolveSignOut: (value: { error: null }) => void = () => {};

    signOut.mockImplementation(
      () =>
        new Promise<{ error: null }>((resolve) => {
          resolveSignOut = resolve;
        }),
    );

    render(<LogoutButton copy={logoutCopy} loginPath="/en/login" />);
    await user.click(screen.getByRole("button", { name: logoutCopy.logout }));

    const pending = await screen.findByRole("button", {
      name: new RegExp(logoutCopy.loggingOut),
    });

    expect(pending).toBeDisabled();

    await user.click(pending);

    expect(signOut).toHaveBeenCalledTimes(1);

    resolveSignOut({ error: null });

    await waitFor(() => {
      expect(replace).toHaveBeenCalledTimes(1);
    });
  });

  it("announces a failure and does not navigate", async () => {
    const user = userEvent.setup();

    signOut.mockResolvedValue({ error: { message: "revoke failed" } });

    render(<LogoutButton copy={logoutCopy} loginPath="/en/login" />);
    await user.click(screen.getByRole("button", { name: logoutCopy.logout }));

    const alert = await screen.findByRole("alert");

    expect(alert).toHaveTextContent(logoutCopy.logoutError);
    expect(alert).not.toHaveTextContent("revoke failed");
    expect(replace).not.toHaveBeenCalled();
  });
});
