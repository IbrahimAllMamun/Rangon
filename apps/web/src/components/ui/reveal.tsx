"use client";

/**
 * Reveals its children once, as they scroll into view.
 *
 * A thin client boundary so server components (the home page, the shop grid)
 * can use a hook-based reveal without becoming client components themselves.
 *
 * Animates `opacity` and `transform` only — both compositor properties — so it
 * cannot shift layout. The element occupies its final space from first paint;
 * only its appearance changes. That keeps CLS at zero, which matters more on a
 * storefront than the animation does.
 */

import * as React from "react";

import { cn } from "@/lib/cn";
import { useScrollReveal } from "@/lib/use-scroll-reveal";

export function Reveal({
  children,
  className,
  /** Stagger within a group. Capped by the caller — see ProductGrid. */
  delay = 0,
  as: Tag = "div",
}: {
  children: React.ReactNode;
  className?: string;
  delay?: number;
  as?: "div" | "section" | "li";
}) {
  const { ref, isVisible } = useScrollReveal<HTMLDivElement>();

  return (
    <Tag
      ref={ref as React.Ref<never>}
      // The hidden state is server-rendered, so without this hook the markup
      // would ship invisible. `data-reveal` lets a <noscript> rule in the root
      // layout force it visible when JS never arrives — a shopper with scripts
      // blocked still sees the products.
      data-reveal=""
      className={cn(
        "transition-[opacity,transform] duration-slow ease-rangon motion-reduce:transition-none",
        isVisible ? "translate-y-0 opacity-100" : "translate-y-3 opacity-0",
        className,
      )}
      style={isVisible && delay ? { transitionDelay: `${delay}ms` } : undefined}
    >
      {children}
    </Tag>
  );
}
