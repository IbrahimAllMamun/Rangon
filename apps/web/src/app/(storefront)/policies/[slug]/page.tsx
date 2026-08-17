import type { Metadata } from "next";
import { notFound } from "next/navigation";

/**
 * Policy pages.
 *
 * The copy below states the defaults the software actually enforces
 * (docs/business-rules.md). The owner must review and sign these off before
 * launch — see docs/operations/go-live-checklist.md.
 */

type Params = Promise<{ slug: string }>;

interface Policy {
  title: string;
  updated: string;
  sections: { heading: string; body: string[] }[];
}

const POLICIES: Record<string, Policy> = {
  shipping: {
    title: "Shipping",
    updated: "August 2026",
    sections: [
      {
        heading: "Where we deliver",
        body: [
          "We deliver across Bangladesh. Inside Dhaka usually takes 1–2 working days; outside Dhaka 2–5 working days.",
          "You can also collect your order from our Panthapath store free of charge.",
        ],
      },
      {
        heading: "Delivery charges",
        body: [
          "Inside Dhaka: ৳70, free on orders over ৳3,000.",
          "Outside Dhaka: ৳130, free on orders over ৳5,000.",
          "The exact charge for your address is shown at checkout before you pay.",
        ],
      },
      {
        heading: "Cash on delivery",
        body: [
          "You can pay the courier when your order arrives. We will call the number on your order before delivery.",
        ],
      },
    ],
  },
  returns: {
    title: "Returns & exchanges",
    updated: "August 2026",
    sections: [
      {
        heading: "Our return window",
        body: [
          "You can return an item within 14 days of receiving it, as long as it is unworn, unwashed and in its original condition with the receipt.",
          "Items marked final sale cannot be returned.",
        ],
      },
      {
        heading: "How to return something",
        body: [
          "Bring the item and your receipt to our store, or contact us to arrange a return for an online order.",
          "Once we receive and check the item, we issue your refund to the method you originally paid with.",
        ],
      },
      {
        heading: "Delivery charges on returns",
        body: [
          "If the item was faulty, damaged, or not what you ordered, we refund the delivery charge too.",
          "If you simply changed your mind, the delivery charge is not refunded.",
        ],
      },
    ],
  },
  privacy: {
    title: "Privacy",
    updated: "August 2026",
    sections: [
      {
        heading: "What we collect",
        body: [
          "Your name, phone number, delivery address and — if you give it — your email address. We keep a record of what you have ordered.",
          "We do not store card numbers. Card payments are handled by the payment terminal or the payment provider.",
        ],
      },
      {
        heading: "How we use it",
        body: [
          "To take payment, deliver your order, handle returns, and keep the accounting records the law requires.",
          "We do not sell your information.",
        ],
      },
      {
        heading: "Your choices",
        body: [
          "Contact us to see, correct or delete the personal information we hold. We keep financial records where we are legally required to, but we can anonymise your personal details.",
        ],
      },
    ],
  },
  terms: {
    title: "Terms",
    updated: "August 2026",
    sections: [
      {
        heading: "Orders",
        body: [
          "Placing an order is an offer to buy. We confirm it once we have checked stock and your details.",
          "Prices and availability shown on this site are confirmed by our system at checkout. If a price is wrong we will contact you before dispatching.",
        ],
      },
      {
        heading: "Cancellation",
        body: [
          "You can cancel an order before it is packed. After that, please use the returns process.",
        ],
      },
    ],
  },
};

export function generateStaticParams() {
  return Object.keys(POLICIES).map((slug) => ({ slug }));
}

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { slug } = await params;
  const policy = POLICIES[slug];
  return policy
    ? { title: policy.title, description: `${policy.title} policy for Rangon Fashion.` }
    : { title: "Policy" };
}

export default async function PolicyPage({ params }: { params: Params }) {
  const { slug } = await params;
  const policy = POLICIES[slug];
  if (!policy) notFound();

  return (
    <article className="container-rangon max-w-3xl py-12">
      <h1 className="font-display text-h1">{policy.title}</h1>
      <p className="mt-2 text-body-sm text-muted">Last updated {policy.updated}</p>

      {policy.sections.map((section) => (
        <section key={section.heading} className="mt-8">
          <h2 className="text-h3">{section.heading}</h2>
          {section.body.map((paragraph, index) => (
            <p key={index} className="mt-3 text-body text-neutral-700">
              {paragraph}
            </p>
          ))}
        </section>
      ))}
    </article>
  );
}
