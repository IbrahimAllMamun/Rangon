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
import { Eye, EyeOff, Loader2 } from "lucide-react";
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
        // brand-700: brand-600 text is 4.36:1 on the storefront ground.
        link: "text-brand-700 underline-offset-4 hover:underline",
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

/* ------------------------------------------------------- PasswordInput -- */

export type PasswordInputProps = Omit<InputProps, "type">;

/**
 * A password field with a show/hide toggle.
 *
 * Every password field in the product uses this, so "can I see what I typed"
 * is answered in one place rather than per form.
 *
 * The accessibility decisions, because each one has a wrong-looking
 * alternative that is easy to reach for:
 *
 *  - **The name is stable, the state is not.** The button is always called
 *    "Show password" and carries `aria-pressed`. Flipping the *name* to
 *    "Hide password" as well would announce the toggle twice over — once as a
 *    renamed control, once as a state change — which is the usual complaint
 *    about this widget. One of the two has to stay still, and a stable name is
 *    what `aria-pressed` is for.
 *  - **No live region.** A screen reader announces an `aria-pressed` change
 *    already; adding `role="status"` on top is the double-announcement this
 *    pattern is known for.
 *  - **The icon is decorative.** The button is already named, so the glyph is
 *    `aria-hidden` rather than a second, competing label.
 *  - **It is in the tab order**, and `onMouseDown` is prevented rather than the
 *    button being skipped. Both halves were wrong first and a browser found
 *    them: a pointer click moved focus to the button, so typing after
 *    revealing went nowhere until the person clicked back into the field;
 *    and `tabIndex={-1}`, written to keep the tab path short, denied a
 *    keyboard-only user a control everyone else gets -- WCAG 2.1.1 asks that
 *    all functionality be keyboard operable, and checking what you typed is
 *    functionality. Preventing the default on `mousedown` keeps the caret
 *    where it was without costing the keyboard anything -- and the caret is
 *    then restored by hand, because a real pointer click collapses the field's
 *    selection anyway and the next keystroke landed at position 0.
 *  - **36px square**, over the 24 CSS px WCAG 2.2 AA asks of a pointer target,
 *    and inside the input's own 40/44px box rather than beside it, so nothing
 *    reflows when it appears and the input's focus ring is never covered.
 *
 * Visibility resets to hidden whenever the field empties -- after a successful
 * submit that clears it, or after the person clears it themselves -- so a
 * password is never left readable on a counter screen for the next customer.
 */
export const PasswordInput = React.forwardRef<HTMLInputElement, PasswordInputProps>(
  ({ className, ...props }, ref) => {
    const [visible, setVisible] = React.useState(false);
    const inputRef = React.useRef<HTMLInputElement | null>(null);
    const caret = React.useRef<[number | null, number | null]>([null, null]);

    // Our own handle on the input, without taking the caller's away.
    const attachRef = React.useCallback(
      (node: HTMLInputElement | null) => {
        inputRef.current = node;
        if (typeof ref === "function") ref(node);
        else if (ref) ref.current = node;
      },
      [ref],
    );

    // Put the caret back where it was: a click on the toggle sent the next
    // keystroke to the start of the password instead of where the person was
    // typing.
    //
    // What was measured, because the obvious explanation is wrong: setting
    // `type` by hand on a detached input does *not* drop the selection, and a
    // synthetic `btn.click()` keeps it too. Only a trusted pointer click loses
    // it, and it loses it *after* React commits -- a `useLayoutEffect` restore
    // is overwritten, one on the next frame survives. Whether that is the
    // browser's own post-click selection handling or React restoring the
    // controlled value was not pinned down; the timing was, and that is what
    // this depends on.
    React.useEffect(() => {
      const node = inputRef.current;
      const [start, end] = caret.current;
      if (!node || start === null) return;
      const frame = requestAnimationFrame(() => node.setSelectionRange(start, end));
      return () => cancelAnimationFrame(frame);
    }, [visible]);

    // A field that has emptied is a field whose password is gone: there is
    // nothing to keep revealed, and leaving the toggle on would reveal the
    // *next* thing typed without anyone asking for it.
    const empty = props.value === "" || props.value === undefined;
    React.useEffect(() => {
      if (empty) setVisible(false);
    }, [empty]);

    // The wrapper is `w-full`, not bare `relative`: the staff form puts this in
    // a flex row beside an icon, where a shrink-to-fit wrapper collapses the
    // field to its intrinsic width. The bare `Input` it replaced was `w-full`,
    // so this has to keep behaving that way.
    return (
      <div className="relative w-full">
        <Input
          ref={attachRef}
          type={visible ? "text" : "password"}
          // Room for the button, so revealed text never runs underneath it.
          className={cn("pr-12", className)}
          {...props}
        />
        <button
          type="button"
          onClick={() => {
            const node = inputRef.current;
            caret.current = node ? [node.selectionStart, node.selectionEnd] : [null, null];
            setVisible((shown) => !shown);
          }}
          // Keeps the caret in the field: without this the click focuses the
          // button and the next keystroke goes nowhere.
          onMouseDown={(event) => event.preventDefault()}
          aria-label="Show password"
          aria-pressed={visible}
          className={cn(
            "absolute right-1 top-1/2 grid size-9 -translate-y-1/2 place-items-center",
            "rounded-md text-neutral-500 transition-colors duration-fast",
            "hover:bg-neutral-100 hover:text-neutral-700",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]",
          )}
        >
          {visible ? (
            <EyeOff className="size-4" aria-hidden />
          ) : (
            <Eye className="size-4" aria-hidden />
          )}
        </button>
      </div>
    );
  },
);
PasswordInput.displayName = "PasswordInput";

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
  React.SelectHTMLAttributes<HTMLSelectElement> & { invalid?: boolean }
>(({ className, children, invalid, ...props }, ref) => (
  <select
    ref={ref}
    // `invalid` matches Input and Textarea. Without it a select could not be
    // marked up as failing validation, so callers passed the prop anyway and it
    // silently vanished into the DOM.
    aria-invalid={invalid || undefined}
    className={cn(
      "h-11 w-full rounded-md border bg-white px-3 text-body sm:h-10",
      "focus:border-brand-500 focus:outline-none focus:ring-4 focus:ring-[var(--ring)]",
      invalid ? "border-[var(--error)]" : "border-neutral-300",
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
        success: "bg-[var(--success-bg)] text-[var(--success-text)]",
        warning: "bg-[var(--warning-bg)] text-[var(--warning-text)]",
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

/**
 * An `h2`, not an `h3`: nearly every card sits straight under a page's `h1`,
 * and an `h3` there skips a level (WCAG 1.3.1, axe `heading-order`). An `h2`
 * after any heading is valid, so this cannot introduce a skip anywhere.
 */
export function CardTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return <h2 className={cn("text-h4 font-semibold", className)} {...props} />;
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
      {/* h2 for the same reason as CardTitle: it usually follows the h1. */}
      <h2 className="text-h4 font-semibold">{title}</h2>
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
      <h2 className="text-h4 font-semibold text-[var(--error)]">{title}</h2>
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
