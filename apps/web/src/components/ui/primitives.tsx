/**
 * Rangon design-system primitives (shadcn-style: Radix behaviour + cva variants
 * + Tailwind tokens). Grouped in one module because they share the same variant
 * vocabulary and are always imported together.
 *
 * Rules enforced here so pages cannot break them:
 *  - `primary` is brand red; `destructive` is semantic red. Never interchangeable.
 *  - Inputs always render a real <label>; placeholder-only fields are impossible.
 *  - Errors are text + aria-describedby, never colour alone.
 */
"use client";

import * as LabelPrimitive from "@radix-ui/react-label";
import * as SeparatorPrimitive from "@radix-ui/react-separator";
import { Slot } from "@radix-ui/react-slot";
import { type VariantProps, cva } from "class-variance-authority";
import { Loader2 } from "lucide-react";
import * as React from "react";

import { cn } from "@/lib/cn";

/* -------------------------------------------------------------- Button -- */

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md font-semibold " +
    // `transform` joins the transition for press feedback: a 3% dip on :active
    // acknowledges the tap before the network does. It is the cheapest possible
    // reassurance on a slow connection, and it is a transform, so it costs no
    // layout. Reduced motion drops it via the global block.
    "transition-[color,background-color,border-color,transform] duration-fast ease-rangon " +
    "active:scale-[0.97] disabled:pointer-events-none disabled:opacity-50 " +
    "focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[var(--ring)] " +
    "focus-visible:border-brand-500 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        primary: "bg-brand-500 text-white hover:bg-brand-600 active:bg-brand-700",
        secondary:
          "border border-neutral-300 bg-white text-neutral-900 hover:bg-neutral-100 active:bg-neutral-200",
        ghost: "text-neutral-700 hover:bg-neutral-100 active:bg-neutral-200",
        // Semantic error red — deliberately NOT the brand red.
        destructive: "bg-[var(--error)] text-white hover:brightness-95 active:brightness-90",
        link: "text-brand-600 underline-offset-4 hover:underline",
        dark: "bg-neutral-900 text-white hover:bg-neutral-800",
      },
      size: {
        sm: "h-8 px-3 text-body-sm [&_svg]:size-4",
        md: "h-10 px-4 text-body-sm [&_svg]:size-4",
        lg: "h-11 px-6 text-body [&_svg]:size-5",
        // POS controls: large touch targets, generous hit area.
        xl: "h-[52px] px-8 text-body-lg [&_svg]:size-6",
        icon: "h-10 w-10 [&_svg]:size-4",
        "icon-lg": "h-12 w-12 [&_svg]:size-5",
      },
      full: { true: "w-full" },
    },
    defaultVariants: { variant: "primary", size: "md" },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  loading?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, full, asChild, loading, children, disabled, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        ref={ref}
        className={cn(buttonVariants({ variant, size, full }), className)}
        disabled={disabled || loading}
        aria-busy={loading || undefined}
        {...props}
      >
        {loading ? (
          <>
            <Loader2 className="animate-spin" aria-hidden />
            <span>{children}</span>
          </>
        ) : (
          children
        )}
      </Comp>
    );
  },
);
Button.displayName = "Button";

/* ------------------------------------------------------ Label / Field -- */

export const Label = React.forwardRef<
  React.ElementRef<typeof LabelPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof LabelPrimitive.Root> & { required?: boolean }
>(({ className, children, required, ...props }, ref) => (
  <LabelPrimitive.Root
    ref={ref}
    className={cn("block text-body-sm font-medium text-neutral-900", className)}
    {...props}
  >
    {children}
    {required && (
      <span className="ml-0.5 text-[var(--error)]" aria-hidden>
        *
      </span>
    )}
  </LabelPrimitive.Root>
));
Label.displayName = "Label";

export interface FieldProps {
  label: string;
  htmlFor: string;
  error?: string;
  hint?: string;
  required?: boolean;
  children: React.ReactNode;
  className?: string;
}

/**
 * Label + control + hint + error, wired with aria-describedby.
 * Every form control in the product goes through this, so a placeholder-only
 * field cannot ship.
 */
export function Field({ label, htmlFor, error, hint, required, children, className }: FieldProps) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <Label htmlFor={htmlFor} required={required}>
        {label}
      </Label>
      {children}
      {hint && !error && (
        <p id={`${htmlFor}-hint`} className="text-caption text-muted">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${htmlFor}-error`} className="text-caption font-medium text-[var(--error)]">
          {error}
        </p>
      )}
    </div>
  );
}

/* --------------------------------------------------------------- Input -- */

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean;
  inputSize?: "md" | "lg";
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, invalid, inputSize = "md", ...props }, ref) => (
    <input
      ref={ref}
      aria-invalid={invalid || undefined}
      className={cn(
        "w-full rounded-md border bg-white px-3 text-body text-neutral-900 outline-none",
        "placeholder:text-neutral-400 transition-colors duration-fast",
        "focus:border-brand-500 focus:ring-4 focus:ring-[var(--ring)]",
        "disabled:cursor-not-allowed disabled:bg-neutral-100 disabled:text-neutral-500",
        inputSize === "lg" ? "h-12 text-body-lg" : "h-11 sm:h-10",
        invalid ? "border-[var(--error)]" : "border-neutral-300",
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = "Input";

export const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }
>(({ className, invalid, ...props }, ref) => (
  <textarea
    ref={ref}
    aria-invalid={invalid || undefined}
    className={cn(
      "w-full rounded-md border bg-white px-3 py-2 text-body outline-none",
      "focus:border-brand-500 focus:ring-4 focus:ring-[var(--ring)]",
      invalid ? "border-[var(--error)]" : "border-neutral-300",
      className,
    )}
    {...props}
  />
));
Textarea.displayName = "Textarea";

export const Select = React.forwardRef<
  HTMLSelectElement,
  React.SelectHTMLAttributes<HTMLSelectElement>
>(({ className, children, ...props }, ref) => (
  <select
    ref={ref}
    className={cn(
      "h-11 w-full rounded-md border border-neutral-300 bg-white px-3 text-body sm:h-10",
      "focus:border-brand-500 focus:outline-none focus:ring-4 focus:ring-[var(--ring)]",
      className,
    )}
    {...props}
  >
    {children}
  </select>
));
Select.displayName = "Select";

export const Checkbox = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(({ className, ...props }, ref) => (
  <input
    ref={ref}
    type="checkbox"
    className={cn(
      "size-4 rounded-sm border-neutral-300 text-brand-500 accent-[var(--brand-500)]",
      "focus-visible:ring-4 focus-visible:ring-[var(--ring)]",
      className,
    )}
    {...props}
  />
));
Checkbox.displayName = "Checkbox";

/* --------------------------------------------------------------- Badge -- */

const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-caption font-medium",
  {
    variants: {
      tone: {
        neutral: "bg-neutral-100 text-neutral-700",
        success: "bg-[var(--success-bg)] text-[var(--success)]",
        warning: "bg-[var(--warning-bg)] text-[var(--warning)]",
        error: "bg-[var(--error-bg)] text-[var(--error)]",
        info: "bg-[var(--info-bg)] text-[var(--info)]",
        brand: "bg-brand-100 text-brand-700",
        dark: "bg-neutral-900 text-white",
      },
    },
    defaultVariants: { tone: "neutral" },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

/** Badges always carry text — colour alone never conveys state (WCAG 1.4.1). */
export function Badge({ className, tone, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}

/* ---------------------------------------------------------------- Card -- */

export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("rounded-lg border border-border bg-surface", className)}
      {...props}
    />
  );
}

export function CardHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex flex-col gap-1 border-b border-border p-4", className)} {...props} />;
}

export function CardTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return <h3 className={cn("text-h4 font-semibold", className)} {...props} />;
}

export function CardContent({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("p-4", className)} {...props} />;
}

/* ----------------------------------------------------------- Feedback -- */

export function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("skeleton rounded-md", className)} aria-hidden {...props} />;
}

export function Spinner({ className }: { className?: string }) {
  return (
    <span role="status" aria-live="polite">
      <Loader2 className={cn("size-5 animate-spin text-brand-500", className)} aria-hidden />
      <span className="sr-only">Loading</span>
    </span>
  );
}

export const Separator = React.forwardRef<
  React.ElementRef<typeof SeparatorPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SeparatorPrimitive.Root>
>(({ className, orientation = "horizontal", ...props }, ref) => (
  <SeparatorPrimitive.Root
    ref={ref}
    decorative
    orientation={orientation}
    className={cn(
      "bg-border",
      orientation === "horizontal" ? "h-px w-full" : "h-full w-px",
      className,
    )}
    {...props}
  />
));
Separator.displayName = "Separator";

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: React.ReactNode;
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
      {icon && <div className="text-neutral-400">{icon}</div>}
      <h3 className="text-h4 font-semibold">{title}</h3>
      {description && <p className="max-w-md text-body-sm text-muted">{description}</p>}
      {action}
    </div>
  );
}

export function ErrorState({
  title = "Something went wrong",
  description,
  onRetry,
}: {
  title?: string;
  description?: string;
  onRetry?: () => void;
}) {
  return (
    <div role="alert" className="flex flex-col items-center gap-3 px-6 py-16 text-center">
      <h3 className="text-h4 font-semibold text-[var(--error)]">{title}</h3>
      {description && <p className="max-w-md text-body-sm text-muted">{description}</p>}
      {onRetry && (
        <Button variant="secondary" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}

/**
 * Error summary for a failed form submit: focusable, at the top, linking to
 * each invalid field. Inline field errors stay in place as well.
 */
export function ErrorSummary({
  errors,
  title = "There is a problem",
}: {
  errors: { field: string; message: string }[];
  title?: string;
}) {
  const ref = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (errors.length) ref.current?.focus();
  }, [errors]);

  if (!errors.length) return null;

  return (
    <div
      ref={ref}
      role="alert"
      tabIndex={-1}
      aria-labelledby="error-summary-title"
      className="rounded-md border-2 border-[var(--error)] bg-[var(--error-bg)] p-4 outline-none"
    >
      <h2 id="error-summary-title" className="text-body font-semibold text-[var(--error)]">
        {title}
      </h2>
      <ul className="mt-2 space-y-1">
        {errors.map((error) => (
          <li key={error.field}>
            <a
              href={`#${error.field}`}
              className="text-body-sm font-medium text-[var(--error)] underline underline-offset-2"
            >
              {error.message}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

export { buttonVariants, badgeVariants };
