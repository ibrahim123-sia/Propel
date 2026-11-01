"use client";

import dynamic from "next/dynamic";
import { useState } from "react";
import type { DialogPanelProps } from "./dialog-panel";

const DialogPanel = dynamic(() => import("./dialog-panel").then((m) => m.DialogPanel), {
  ssr: false,
});

/**
 * A form dialog whose code (Radix focus trap, scroll lock, portal) loads the first time it
 * opens, not with the page. It stays mounted after that, so closing still animates.
 */
export function LazyDialog(props: DialogPanelProps) {
  const [used, setUsed] = useState(props.open);
  if (props.open && !used) setUsed(true);
  return used ? <DialogPanel {...props} /> : null;
}
