import { Button, Tooltip, TooltipContent, TooltipTrigger } from "@garden/ui";
import type { ComponentProps, ReactNode } from "react";

type IconToolProps = Omit<ComponentProps<typeof Button>, "aria-label" | "size" | "title"> & {
  label: string;
  hint?: ReactNode;
};

/** App toolbar composition; Garden owns the button and tooltip behavior. */
export function IconTool({ label, hint, variant = "ghost", children, ...props }: IconToolProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button type="button" size="icon" variant={variant} aria-label={label} {...props}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent className="workspace-tooltip" collisionPadding={8}>
        {label}
        {hint && <span className="ml-2 text-tooltip-muted">{hint}</span>}
      </TooltipContent>
    </Tooltip>
  );
}
