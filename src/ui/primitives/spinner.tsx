import { cn } from "@/ui/cn";
import { Loader2Icon } from "lucide-react";

function Spinner({ className, ...props }: React.ComponentProps<"svg">) {
  return (
    <Loader2Icon
      data-slot="spinner"
      aria-hidden={props["aria-label"] ? undefined : true}
      role={props["aria-label"] ? "status" : undefined}
      className={cn("size-4 animate-spin", className)}
      {...props}
    />
  );
}

export { Spinner };
