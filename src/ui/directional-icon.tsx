import { cn } from "@/ui/cn";

function DirectionalIcon({
  className,
  ...props
}: React.ComponentProps<"span">) {
  return (
    <span
      data-directional=""
      className={cn("inline-flex shrink-0", className)}
      {...props}
    />
  );
}

export { DirectionalIcon };
