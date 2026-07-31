import type { ReactNode } from "react";
import { BanIcon, CircleXIcon, SearchXIcon } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/ui/primitives/alert";

const statusPresentation = {
  error: {
    icon: CircleXIcon,
    variant: "destructive",
  },
  forbidden: {
    icon: BanIcon,
    variant: "warning",
  },
  "not-found": {
    icon: SearchXIcon,
    variant: "info",
  },
} as const;

type StatusStateProps = Omit<React.ComponentProps<typeof Alert>, "title"> & {
  status: keyof typeof statusPresentation;
  title: ReactNode;
  description: ReactNode;
  actions?: ReactNode;
};

function StatusState({
  status,
  title,
  description,
  actions,
  ...props
}: StatusStateProps) {
  const presentation = statusPresentation[status];
  const Icon = presentation.icon;

  return (
    <Alert
      data-slot="status-state"
      data-status={status}
      variant={presentation.variant}
      {...props}
    >
      <Icon aria-hidden="true" />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>
        <div className="flex flex-col items-start gap-3">
          <div>{description}</div>
          {actions ? (
            <div className="flex flex-wrap gap-2">{actions}</div>
          ) : null}
        </div>
      </AlertDescription>
    </Alert>
  );
}

export { StatusState };
