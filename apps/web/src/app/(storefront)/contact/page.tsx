import { Clock, Mail, MapPin, Phone } from "lucide-react";
import type { Metadata } from "next";

import { Card } from "@/components/ui/primitives";

export const metadata: Metadata = {
  title: "Contact us",
  description: "Talk to Rangon Fashion — phone, email, or visit our Panthapath store in Dhaka.",
};

export default function ContactPage() {
  return (
    <div className="container-rangon max-w-3xl py-12">
      <h1 className="font-display text-h1">Contact us</h1>
      <p className="mt-2 text-body text-muted">
        Questions about an order, a size, or a return? We are happy to help.
      </p>

      <div className="mt-8 grid gap-4 sm:grid-cols-2">
        <Card className="p-5">
          <Phone className="size-5 text-brand-500" aria-hidden />
          <h2 className="mt-3 text-h4">Phone</h2>
          <p className="mt-1 text-body-sm text-muted">
            <a href="tel:+8801700000000" className="hover:text-brand-600">
              +880 1700 000000
            </a>
          </p>
        </Card>

        <Card className="p-5">
          <Mail className="size-5 text-brand-500" aria-hidden />
          <h2 className="mt-3 text-h4">Email</h2>
          <p className="mt-1 text-body-sm text-muted">
            <a href="mailto:hello@rangonfashion.com" className="hover:text-brand-600">
              hello@rangonfashion.com
            </a>
          </p>
        </Card>

        <Card className="p-5">
          <MapPin className="size-5 text-brand-500" aria-hidden />
          <h2 className="mt-3 text-h4">Store</h2>
          <address className="mt-1 text-body-sm not-italic text-muted">
            Level 3, Bashundhara City
            <br />
            Panthapath, Dhaka 1215
          </address>
        </Card>

        <Card className="p-5">
          <Clock className="size-5 text-brand-500" aria-hidden />
          <h2 className="mt-3 text-h4">Opening hours</h2>
          <p className="mt-1 text-body-sm text-muted">
            Saturday–Thursday, 10:00–20:00
            <br />
            Friday, 15:00–20:00
          </p>
        </Card>
      </div>
    </div>
  );
}
