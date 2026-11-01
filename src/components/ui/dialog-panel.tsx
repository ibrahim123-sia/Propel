"use client";

import { useLayoutEffect, useRef, type ReactNode } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export type DialogPanelProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
};

/**
 * The site's form dialog (title, a short line under it, the form). Load it through
 * `LazyDialog`, so its Radix code comes with the first open rather than with the page.
 */
export function DialogPanel({
  open,
  onOpenChange,
  title,
  description,
  children,
}: DialogPanelProps) {
  // The dialog opens from plain buttons (no Radix trigger), so focus is sent back by hand.
  const opener = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    // Runs before the focus trap moves focus into the dialog.
    if (open) opener.current = document.activeElement as HTMLElement | null;
  }, [open]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[90dvh] overflow-y-auto sm:max-w-md"
        onCloseAutoFocus={(e) => {
          if (!opener.current?.isConnected) return;
          e.preventDefault();
          opener.current.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  );
}
