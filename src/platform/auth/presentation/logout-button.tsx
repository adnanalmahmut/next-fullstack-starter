"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { signOut } from "@/platform/auth/auth-client";
import { Alert, AlertDescription } from "@/ui/primitives/alert";
import { Button } from "@/ui/primitives/button";
import { Spinner } from "@/ui/primitives/spinner";

export type LogoutButtonCopy = {
  readonly logout: string;
  readonly loggingOut: string;
  readonly logoutError: string;
};

type LogoutButtonProps = {
  readonly copy: LogoutButtonCopy;
  readonly loginPath: string;
};

/**
 * Signing out revokes the server session before navigating. Clearing client
 * state is never treated as a sign-out, and navigation only happens after the
 * server confirms the session was removed.
 */
export function LogoutButton({ copy, loginPath }: LogoutButtonProps) {
  const router = useRouter();
  const [isPending, setIsPending] = useState(false);
  const [hasFailed, setHasFailed] = useState(false);

  async function handleLogout() {
    if (isPending) {
      return;
    }

    setIsPending(true);
    setHasFailed(false);

    try {
      const result = await signOut();

      if (result.error) {
        setHasFailed(true);
        setIsPending(false);

        return;
      }

      router.replace(loginPath);
      router.refresh();
    } catch {
      setHasFailed(true);
      setIsPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {hasFailed ? (
        <Alert variant="destructive" data-slot="logout-error">
          <AlertDescription>{copy.logoutError}</AlertDescription>
        </Alert>
      ) : null}

      <Button
        type="button"
        variant="outline"
        disabled={isPending}
        onClick={handleLogout}
      >
        {isPending ? <Spinner /> : null}
        {isPending ? copy.loggingOut : copy.logout}
      </Button>
    </div>
  );
}
