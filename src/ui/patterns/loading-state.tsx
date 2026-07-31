import { cn } from "@/ui/cn";
import { Skeleton } from "@/ui/primitives/skeleton";
import { Spinner } from "@/ui/primitives/spinner";

type LoadingStateProps = React.ComponentProps<"div"> & {
  label: string;
  variant?: "compact" | "content";
};

function LoadingState({
  className,
  label,
  variant = "compact",
  ...props
}: LoadingStateProps) {
  return (
    <div
      data-slot="loading-state"
      data-variant={variant}
      role="status"
      aria-live="polite"
      aria-busy="true"
      className={cn(
        "flex items-center gap-2 text-sm text-muted-foreground",
        variant === "content" && "w-full flex-col items-stretch gap-3",
        className,
      )}
      {...props}
    >
      {variant === "compact" ? (
        <Spinner />
      ) : (
        <>
          <Skeleton className="h-5 w-2/5" />
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-4 w-3/4" />
        </>
      )}
      <span className={cn(variant === "content" && "sr-only")}>{label}</span>
    </div>
  );
}

export { LoadingState };
