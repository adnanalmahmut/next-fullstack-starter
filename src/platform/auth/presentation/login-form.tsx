"use client";

import { useRouter } from "next/navigation";
import { useId, useState, type FormEvent } from "react";

import { signIn } from "@/platform/auth/auth-client";
import { Alert, AlertDescription, AlertTitle } from "@/ui/primitives/alert";
import { Button } from "@/ui/primitives/button";
import { Field, FieldLabel } from "@/ui/primitives/field";
import { Input } from "@/ui/primitives/input";
import { Spinner } from "@/ui/primitives/spinner";

export type LoginFormCopy = {
  readonly emailLabel: string;
  readonly emailPlaceholder: string;
  readonly passwordLabel: string;
  readonly submit: string;
  readonly submitting: string;
  readonly errorTitle: string;
  readonly invalidCredentials: string;
  readonly unexpectedError: string;
};

type LoginFormProps = {
  readonly copy: LoginFormCopy;
  readonly returnTo: string;
};

type FormStatus = "idle" | "submitting";

/**
 * Sign-in is performed through the Better Auth client so the server sets the
 * session cookie. The form never stores a token, never inspects the session to
 * decide access, and never surfaces a provider message: an authentication failure
 * always renders the same localized text so the response cannot be used to probe
 * which addresses exist.
 */
export function LoginForm({ copy, returnTo }: LoginFormProps) {
  const router = useRouter();
  const emailId = useId();
  const passwordId = useId();
  const [status, setStatus] = useState<FormStatus>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const isSubmitting = status === "submitting";

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (isSubmitting) {
      return;
    }

    const formData = new FormData(event.currentTarget);
    const email = String(formData.get("email") ?? "");
    const password = String(formData.get("password") ?? "");

    setStatus("submitting");
    setErrorMessage(null);

    try {
      const result = await signIn.email({
        email,
        password,
      });

      if (result.error) {
        setErrorMessage(copy.invalidCredentials);
        setStatus("idle");

        return;
      }

      router.replace(returnTo);
      router.refresh();
    } catch {
      setErrorMessage(copy.unexpectedError);
      setStatus("idle");
    }
  }

  return (
    <form className="flex flex-col gap-6" noValidate onSubmit={handleSubmit}>
      {errorMessage ? (
        <Alert variant="destructive" data-slot="login-error">
          <AlertTitle>{copy.errorTitle}</AlertTitle>
          <AlertDescription>{errorMessage}</AlertDescription>
        </Alert>
      ) : null}

      <Field>
        <FieldLabel htmlFor={emailId}>{copy.emailLabel}</FieldLabel>
        <Input
          id={emailId}
          name="email"
          type="email"
          dir="ltr"
          autoComplete="email"
          placeholder={copy.emailPlaceholder}
          required
          disabled={isSubmitting}
        />
      </Field>

      <Field>
        <FieldLabel htmlFor={passwordId}>{copy.passwordLabel}</FieldLabel>
        <Input
          id={passwordId}
          name="password"
          type="password"
          dir="ltr"
          autoComplete="current-password"
          required
          disabled={isSubmitting}
        />
      </Field>

      <Button type="submit" disabled={isSubmitting}>
        {isSubmitting ? <Spinner /> : null}
        {isSubmitting ? copy.submitting : copy.submit}
      </Button>
    </form>
  );
}
