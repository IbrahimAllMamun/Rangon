"use client";

import * as React from "react";

import { Input, type InputProps } from "@/components/ui/primitives";
import { cn } from "@/lib/cn";
import { DIAL_PREFIX, toInputValue } from "@/lib/phone";

export interface PhoneInputProps extends Omit<InputProps, "value" | "onChange" | "type"> {
  /** The subscriber digits, `1712345678`. Never the country code. */
  value: string;
  /** Called with the cleaned subscriber digits, never with what was typed. */
  onChange: (subscriber: string) => void;
}

/**
 * A Bangladeshi mobile number, entered as the ten digits that actually vary.
 *
 * `+880` is printed beside the box rather than typed into it, so a number has
 * one shape and there is no decision for the customer to get wrong. What they
 * type is cleaned on every keystroke: digits only, the country code and the
 * national trunk `0` dropped, capped at ten. Pasting `+880 1712-345678`,
 * `01712345678` or `8801712345678` all leave `1712345678` in the box.
 *
 * The prefix is announced rather than hidden: a screen reader user who is told
 * only "Mobile number" has no way to know the country code is already supplied,
 * and would type it again. It is attached with `aria-describedby` alongside
 * whatever the caller passes, because `Field` renders the hint and the error but
 * leaves the association to the caller.
 */
export const PhoneInput = React.forwardRef<HTMLInputElement, PhoneInputProps>(
  (
    { value, onChange, className, invalid, disabled, "aria-describedby": describedBy, ...props },
    ref,
  ) => {
    const prefixId = React.useId();
    return (
      <div
        className={cn(
          "flex items-stretch rounded-md border bg-white transition-colors duration-fast",
          "focus-within:border-brand-500 focus-within:ring-4 focus-within:ring-[var(--ring)]",
          invalid ? "border-[var(--error)]" : "border-neutral-300",
          disabled && "bg-neutral-100",
          className,
        )}
      >
        <span
          id={prefixId}
          className={cn(
            "tabular flex shrink-0 select-none items-center border-r border-neutral-200 px-3",
            "text-body text-muted",
            disabled && "text-neutral-400",
          )}
        >
          {DIAL_PREFIX}
        </span>
        <Input
          ref={ref}
          type="tel"
          inputMode="numeric"
          autoComplete="tel-national"
          // Deliberately no `maxLength`. The browser applies it to the raw text
          // before `onChange` runs, so pasting the local form `01711223344` was
          // cut to ten characters *and then* had its trunk `0` stripped, leaving
          // nine digits and a number that fails validation. The cap belongs
          // after normalisation, where `toInputValue` applies it.
          placeholder="1712345678"
          value={value}
          disabled={disabled}
          invalid={invalid}
          onChange={(event) => onChange(toInputValue(event.target.value))}
          aria-describedby={[prefixId, describedBy].filter(Boolean).join(" ")}
          // The wrapper draws the border, the focus ring and the invalid state;
          // the control inside must not draw a second set on top of them.
          className="tabular border-0 bg-transparent focus:border-0 focus:ring-0"
          {...props}
        />
      </div>
    );
  },
);
PhoneInput.displayName = "PhoneInput";
