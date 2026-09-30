import { Controller, Param, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import { AllowAny } from '../auth/authentication';
import { ThrottleScope } from '../auth/throttle';
import { slugParam } from '../common/errors';
import { ReviewsService } from '../engagement/reviews.service';
import { requestData } from '../http/request-body';
import { CustomerOrdersService } from '../orders/customer-orders.service';

/**
 * `ShopProductViewSet.reviews`: a customer reviews a product they have
 * received. The viewset's `search` throttle scope applies, as to every action
 * of that viewset.
 *
 * Open to anyone, as the Django API has it: its URL conf builds the view with
 * `as_view({"post": "reviews"})`, which ignores the action's
 * `permission_classes=[IsAuthenticated, IsCustomer]` (only a router applies
 * them), so the viewset's `AllowAny` is what runs. An anonymous or staff
 * caller is refused by the customer check instead: 400, not 401 or 403. A
 * Django defect copied until it is fixed there (docs/architecture/nest-port.md).
 */
@Controller('api/v1/shop')
export class ShopReviewsController {
  constructor(
    private readonly reviews: ReviewsService,
    private readonly orders: CustomerOrdersService,
  ) {}

  @Post('products/:slug/reviews/')
  @AllowAny()
  @ThrottleScope('search')
  async submit(@Param('slug') slug: string, @Req() request: FastifyRequest) {
    const valid = slugParam(slug);
    const customerId = await this.orders.customerOf(request.user?.id);
    return this.reviews.submit(valid, customerId, () => requestData(request));
  }
}
