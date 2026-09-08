"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { Loader2, Search, UserPlus, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { Button, Field, Input } from "@/components/ui/primitives";
import { ApiError, apiClient } from "@/lib/api/client";
import type { PosCustomer } from "@/lib/api/types";
import { useDebouncedCallback } from "@/lib/use-debounced-callback";

/**
 * Attach a customer to the sale at the counter.
 *
 * Two jobs, in the order a cashier does them: find the person by the number
 * they give, and create them when the search comes back empty. The search
 * comes first deliberately -- `phone` is unique, so creating without looking
 * is how a shop ends up with the same person twice under slightly different
 * spellings of their name.
 *
 * Keyboard-operable throughout (CLAUDE.md section 11 -- the POS must be):
 * the phone field takes focus on open, Up/Down walk the results, Enter attaches
 * the highlighted one, and Esc closes. Nothing here needs a mouse.
 */

/** Matches the scan field's debounce; see `SEARCH_DEBOUNCE_MS` in register.tsx. */
const SEARCH_DEBOUNCE_MS = 220;

/**
 * Mirrors `CustomerViewSet.LOOKUP_MIN_LENGTH`.
 *
 * The server refuses to search below this and says so in `min_length`; this
 * copy exists so the client does not make the request at all, and so the field
 * can say why nothing is happening rather than looking broken.
 */
const MIN_SEARCH_LENGTH = 3;

export function CustomerPanel({
  onClose,
  onAttach,
}: {
  onClose: () => void;
  onAttach: (customer: PosCustomer) => void;
}) {
  const [phone, setPhone] = useState("");
  const [results, setResults] = useState<PosCustomer[]>([]);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const phoneRef = useRef<HTMLInputElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const searchAbort = useRef<AbortController | null>(null);

  const search = useCallback(async (term: string) => {
    // Supersede rather than race: responses can arrive out of order, and a
    // slower earlier one would overwrite the results for what is on screen.
    searchAbort.current?.abort();
    const controller = new AbortController();
    searchAbort.current = controller;

    setSearching(true);
    try {
      const data = await apiClient<{ results: PosCustomer[] }>(
        `/customers/lookup/?phone=${encodeURIComponent(term)}`,
        { signal: controller.signal },
      );
      setResults(data.results);
      setHighlighted(0);
      setSearched(true);
    } catch (caught) {
      if (controller.signal.aborted) return; // superseded — leave state alone
      setResults([]);
      setSearched(true);
      setError(caught instanceof ApiError ? caught.message : "The lookup failed.");
    } finally {
      if (!controller.signal.aborted) setSearching(false);
    }
  }, []);

  const [queueSearch, cancelQueuedSearch] = useDebouncedCallback(
    (term: string) => void search(term),
    SEARCH_DEBOUNCE_MS,
  );

  useEffect(() => {
    phoneRef.current?.focus();
  }, []);

  // An in-flight lookup must not outlive the dialog that asked for it.
  useEffect(() => () => searchAbort.current?.abort(), []);

  function onPhoneChange(value: string) {
    setPhone(value);
    setError(null);
    setFieldErrors({});
    // Editing the number invalidates whatever was found for the old one, and
    // the create form along with it: it was offered for a number that has
    // since changed.
    setCreating(false);

    if (value.trim().length < MIN_SEARCH_LENGTH) {
      cancelQueuedSearch();
      searchAbort.current?.abort();
      setResults([]);
      setSearched(false);
      setSearching(false);
      return;
    }
    queueSearch(value.trim());
  }

  function attach(customer: PosCustomer) {
    onAttach(customer);
    onClose();
  }

  /**
   * Move through the results without leaving the phone field.
   *
   * Enter does whichever of the two jobs the state implies: attach the
   * highlighted match, or -- when the search found nobody -- open the create
   * form for the number just typed. That is what makes the whole flow
   * keyboard-only: number, Enter, name, Enter.
   */
  function onPhoneKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (results.length) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setHighlighted((index) => (index + 1) % results.length);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        setHighlighted((index) => (index - 1 + results.length) % results.length);
      } else if (event.key === "Enter") {
        event.preventDefault();
        const chosen = results[highlighted];
        if (chosen) attach(chosen);
      }
      return;
    }

    // Not while a search is in flight: the answer may still be "found them",
    // and offering to create a duplicate is the one thing this panel exists
    // to prevent.
    if (event.key === "Enter" && searched && !searching && !creating) {
      event.preventDefault();
      startCreating();
    }
  }

  function startCreating() {
    setCreating(true);
    setError(null);
    // The number typed into the search is the number being registered; asking
    // for it a second time is how they end up different.
    window.setTimeout(() => nameRef.current?.focus(), 0);
  }

  async function create(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    setFieldErrors({});
    try {
      const customer = await apiClient<PosCustomer>("/customers/", {
        method: "POST",
        // `customer_type` is deliberately not sent: the model defaults to
        // GUEST, and WALK_IN is reserved for the single anonymous row each
        // branch keeps for unnamed counter sales (business rules section 6).
        // A named customer must not claim it.
        body: {
          name: name.trim(),
          phone: phone.trim(),
          ...(email.trim() ? { email: email.trim() } : {}),
        },
      });
      attach(customer);
    } catch (caught) {
      if (caught instanceof ApiError) {
        const fields = Object.fromEntries(
          caught.fieldErrors().map(({ field, message }) => [field, message]),
        );
        setFieldErrors(fields);
        // A duplicate phone means the record exists but the search did not
        // offer it — a deactivated customer is the usual reason. Saying so is
        // more use than repeating the server's "already exists".
        if (fields.phone) {
          setError(
            `${phone.trim()} is already on file but was not in the results — it may belong to a deactivated customer. An admin can reactivate them from the customers screen.`,
          );
        } else if (!Object.keys(fields).length) {
          setError(caught.message);
        }
      } else {
        setError("The customer could not be created.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  const tooShort = phone.trim().length > 0 && phone.trim().length < MIN_SEARCH_LENGTH;
  const noMatches = searched && !searching && results.length === 0;

  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-neutral-950/50" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(92vw,520px)] -translate-x-1/2 -translate-y-1/2 rounded-xl bg-surface shadow-lg focus:outline-none">
          <div className="flex items-center justify-between border-b border-border px-5 py-4">
            <Dialog.Title className="text-h3">Customer</Dialog.Title>
            <Dialog.Close asChild>
              <Button variant="ghost" size="icon" aria-label="Close">
                <X aria-hidden />
              </Button>
            </Dialog.Close>
          </div>
          <Dialog.Description className="sr-only">
            Search for a customer by phone number to attach them to this sale, or create a new
            customer if the search finds nobody.
          </Dialog.Description>

          <div className="p-5">
            <Field
              label="Phone number"
              htmlFor="customer-phone"
              hint={
                tooShort
                  ? `Type at least ${MIN_SEARCH_LENGTH} digits to search.`
                  : "The last few digits are enough."
              }
            >
              <div className="relative">
                <Search
                  className="pointer-events-none absolute left-3 top-1/2 size-5 -translate-y-1/2 text-muted"
                  aria-hidden
                />
                <Input
                  id="customer-phone"
                  ref={phoneRef}
                  inputSize="lg"
                  className="pl-10"
                  type="tel"
                  inputMode="tel"
                  autoComplete="off"
                  placeholder="01712345678"
                  value={phone}
                  onChange={(event) => onPhoneChange(event.target.value)}
                  onKeyDown={onPhoneKeyDown}
                  // `Field` renders the hint but leaves the association to the
                  // caller, so both ids are named here or the hint is
                  // announced to nobody.
                  aria-describedby="customer-phone-hint customer-search-status"
                />
                {searching && (
                  <Loader2
                    className="absolute right-3 top-1/2 size-5 -translate-y-1/2 animate-spin text-muted"
                    aria-hidden
                  />
                )}
              </div>
            </Field>

            {/* Screen readers get the result count; sighted users get the list. */}
            <p id="customer-search-status" className="sr-only" role="status" aria-live="polite">
              {searching
                ? "Searching"
                : searched
                  ? `${results.length} customer${results.length === 1 ? "" : "s"} found`
                  : ""}
            </p>

            {results.length > 0 && (
              <ul
                id="customer-results"
                className="mt-3 max-h-64 divide-y divide-border overflow-y-auto rounded-md border border-border"
              >
                {results.map((customer, index) => (
                  <li key={customer.id}>
                    <button
                      type="button"
                      onClick={() => attach(customer)}
                      onMouseEnter={() => setHighlighted(index)}
                      aria-current={index === highlighted}
                      className={`flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors duration-fast ${
                        index === highlighted ? "bg-brand-50" : "hover:bg-neutral-100"
                      }`}
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-body font-medium">
                          {customer.name}
                        </span>
                        <span className="tabular block text-body-sm text-muted">
                          {customer.phone}
                        </span>
                      </span>
                      <span className="shrink-0 text-caption text-muted">
                        {customer.total_orders} order{customer.total_orders === 1 ? "" : "s"}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}

            {noMatches && !creating && (
              <div className="mt-3 rounded-md border border-dashed border-neutral-300 p-4 text-center">
                <p className="text-body-sm text-muted">
                  Nobody on file with that number.
                </p>
                <Button type="button" variant="secondary" className="mt-3" onClick={startCreating}>
                  <UserPlus aria-hidden /> Add {phone.trim()} as a new customer
                </Button>
              </div>
            )}

            {creating && (
              <form onSubmit={create} className="mt-4 space-y-3 border-t border-border pt-4">
                <p className="text-body-sm text-muted">
                  New customer ·{" "}
                  <span className="tabular font-medium text-neutral-900">{phone.trim()}</span>
                </p>
                <Field label="Name" htmlFor="customer-name" required error={fieldErrors.name}>
                  <Input
                    id="customer-name"
                    ref={nameRef}
                    inputSize="lg"
                    autoComplete="off"
                    value={name}
                    invalid={Boolean(fieldErrors.name)}
                    onChange={(event) => setName(event.target.value)}
                  />
                </Field>
                <Field
                  label="Email"
                  htmlFor="customer-email"
                  hint="Optional."
                  error={fieldErrors.email}
                >
                  <Input
                    id="customer-email"
                    type="email"
                    autoComplete="off"
                    value={email}
                    invalid={Boolean(fieldErrors.email)}
                    onChange={(event) => setEmail(event.target.value)}
                  />
                </Field>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="secondary"
                    full
                    onClick={() => setCreating(false)}
                  >
                    Cancel
                  </Button>
                  <Button type="submit" full loading={submitting} disabled={!name.trim()}>
                    Save and attach
                  </Button>
                </div>
              </form>
            )}

            {error && (
              <p
                role="alert"
                className="mt-3 rounded-md bg-[var(--error)]/10 px-3 py-2 text-body-sm text-[var(--error)]"
              >
                {error}
              </p>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
