"use client";

import * as TabsPrimitive from "@radix-ui/react-tabs";
import * as React from "react";

import { cn } from "@/lib/cn";

/**
 * Tabs on Radix, which supplies the WAI-ARIA tabs pattern: `tablist`/`tab`/
 * `tabpanel` roles, arrow keys between tabs, Home/End, and one tab stop for
 * the whole list. Styled here once so every tabbed screen looks the same.
 *
 * The active tab is marked by an underline *and* weight, not by colour alone
 * (WCAG 1.4.1). Brand red is the underline because it marks the current
 * location, which is emphasis, not an action.
 */
export const Tabs = TabsPrimitive.Root;

export const TabsList = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.List
    ref={ref}
    className={cn(
      "scrollbar-none flex gap-1 overflow-x-auto border-b border-border",
      className,
    )}
    {...props}
  />
));
TabsList.displayName = "TabsList";

export const TabsTrigger = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Trigger
    ref={ref}
    className={cn(
      "-mb-px inline-flex h-11 shrink-0 items-center gap-2 whitespace-nowrap border-b-2 border-transparent px-3",
      "text-body-sm font-medium text-muted transition-colors duration-fast",
      "hover:text-neutral-900 [&_svg]:size-4",
      "focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[var(--ring)]",
      "data-[state=active]:border-brand-500 data-[state=active]:font-semibold data-[state=active]:text-neutral-900",
      className,
    )}
    {...props}
  />
));
TabsTrigger.displayName = "TabsTrigger";

export const TabsContent = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Content
    ref={ref}
    className={cn("mt-6 focus-visible:outline-none", className)}
    {...props}
  />
));
TabsContent.displayName = "TabsContent";
