import { MessageCircle } from "lucide-react";

/**
 * Float-over WhatsApp contact, environment-gated.
 *
 * Close to mandatory for retail in Bangladesh: a shopper who is unsure about a
 * size asks on WhatsApp rather than emailing, and a shop that does not answer
 * there loses the sale to one that does.
 *
 * It renders nothing at all when `NEXT_PUBLIC_WHATSAPP_NUMBER` is unset, so a
 * deployment that has no number does not advertise a channel nobody is
 * watching — which is worse than not offering it.
 *
 * A server component: the number is baked in at build time and there is no
 * state, so this ships no JavaScript.
 */

/** Digits only, as wa.me requires: `8801712000111`, not `+880 1712-000111`. */
function waDigits(raw: string): string {
  return raw.replace(/\D/g, "");
}

export function WhatsAppButton() {
  const number = waDigits(process.env.NEXT_PUBLIC_WHATSAPP_NUMBER ?? "");
  if (!number) return null;

  const greeting = process.env.NEXT_PUBLIC_WHATSAPP_GREETING ?? "Hello! I have a question about";
  const href = `https://wa.me/${number}?text=${encodeURIComponent(greeting)}`;

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      // Above the page, below the cart drawer and any dialog: a shopper who
      // has opened the cart is buying, and must not be covered by a button
      // asking whether they have questions.
      className="no-print fixed bottom-5 right-5 z-30 flex items-center gap-2 rounded-full bg-[#25D366] px-4 py-3 text-body-sm font-semibold text-white shadow-lg transition-transform duration-fast hover:scale-105 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[var(--ring)] motion-reduce:transition-none motion-reduce:hover:scale-100"
    >
      <MessageCircle className="size-5" aria-hidden />
      {/* The label is hidden on small screens where it would crowd the
          add-to-cart bar, but stays in the accessible name either way. */}
      <span className="sr-only sm:not-sr-only">Chat on WhatsApp</span>
      <span className="sr-only sm:hidden">Chat on WhatsApp</span>
    </a>
  );
}
