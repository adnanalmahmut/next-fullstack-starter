import { cn } from "@/ui/cn";

function PageContainer({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="page-container"
      className={cn(
        "mx-auto w-full max-w-(--page-max-width) px-(--page-padding-inline)",
        className,
      )}
      {...props}
    />
  );
}

export { PageContainer };
