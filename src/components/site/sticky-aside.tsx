"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "cn";

const TOP = 96; // below the sticky header
const GAP = 16;

/**
 * A sidebar that stays in view while the page scrolls (desktop). When it is taller than the
 * window it first scrolls with the page until its end is in view, then stays there, so the
 * whole of it (a contact form's send button too) can always be reached.
 */
export function StickyAside({ children, className }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(TOP);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = () => setTop(Math.min(TOP, window.innerHeight - el.offsetHeight - GAP));
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(el);
    window.addEventListener("resize", fit);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", fit);
    };
  }, []);

  return (
    <div ref={ref} className={cn("lg:sticky lg:self-start", className)} style={{ top }}>
      {children}
    </div>
  );
}
