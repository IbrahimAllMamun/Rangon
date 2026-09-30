import { Injectable } from '@nestjs/common';

import { OrganizationService, TaxSettings } from '../accounts/organization.service';
import { ProductPayloadService } from '../catalog/product-payload.service';
import { ListedProduct } from '../catalog/product-search';
import { AvailabilityService } from '../inventory/availability.service';

/**
 * Products to payloads, the way every storefront endpoint does it: fetch the
 * relations, read stock at the storefront branch, apply the organisation's
 * VAT treatment once for the whole list.
 */
@Injectable()
export class StorefrontProducts {
  constructor(
    private readonly organization: OrganizationService,
    private readonly payloads: ProductPayloadService,
    private readonly stock: AvailabilityService,
  ) {}

  async serialise(
    products: ListedProduct[],
    options: { branchId?: string | null; tax?: TaxSettings } = {},
  ): Promise<Record<string, unknown>[]> {
    if (!products.length) return [];
    const branchId =
      options.branchId !== undefined
        ? options.branchId
        : await this.organization.storefrontBranchId();
    const relations = await this.payloads.relations(products.map((product) => product.id));
    const variantIds = [...relations.values()].flatMap((relation) =>
      relation.variants.map((v) => v.id),
    );
    const snapshots = await this.stock.availability(branchId, variantIds);
    const tax = options.tax ?? (await this.organization.taxSettings());
    return products.map((product) =>
      this.payloads.payload(
        product,
        relations.get(product.id) ?? { images: [], variants: [] },
        snapshots,
        tax,
      ),
    );
  }
}
