/** @description shadcn Spinner — short async action indicator. */
import type * as React from "react";
import { Loader2Icon } from "lucide-react";

import { cn } from "@/lib/cn";

function Spinner({ className, ...props }: React.ComponentProps<"svg">) {
  return (
    <Loader2Icon
      role="status"
      aria-label="Loading"
      className={cn("size-4 animate-spin", className)}
      {...props}
    />
  );
}

export { Spinner };
