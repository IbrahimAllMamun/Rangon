import { Delete, Get, HttpCode, Inject, Param, Patch, Post, Put, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';

import type { RequestUser } from '../../auth/authentication';
import { Action, StaffView } from '../../auth/permissions';
import { auditContext, AuditActor } from '../../common/audit';
import { absoluteUri } from '../../common/http';
import { Params, QueryDict } from '../../common/query-dict';
import { ENV, Env } from '../../config/env';
import { requestData } from '../../http/request-body';
import { lookupParam, PRODUCT_PERMISSIONS } from './catalog-admin.controller';
import { ProductImportService } from './product-import.service';
import { ProductsService } from './products.service';

function actor(request: FastifyRequest): AuditActor {
  const user = request.user as RequestUser;
  return { id: user.id, email: user.email };
}

/** `ProductViewSet`. */
@StaffView('products', {
  ...PRODUCT_PERMISSIONS,
  generate_variants: ['products.create'],
  publish: ['products.update'],
  unpublish: ['products.update'],
  // An import creates products and can receive stock, so it needs both.
  import_csv: ['products.create', 'inventory.adjust'],
})
export class ProductsController {
  constructor(
    private readonly products: ProductsService,
    private readonly imports: ProductImportService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** A spreadsheet of products: a dry run unless `dry_run` is false. Multipart only. */
  @Post('products/import/')
  @Action('import_csv')
  async importCsv(@Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    const { status, body } = await this.imports.handle(
      request.user as RequestUser,
      requestData(request, { multipartOnly: true }),
      actor(request),
      auditContext(request, this.env),
    );
    reply.status(status);
    return body;
  }

  @Get('products/')
  @Action('list')
  list(@Params() query: QueryDict, @Req() request: FastifyRequest) {
    return this.products.list(query, absoluteUri(request, this.env));
  }

  @Post('products/')
  @Action('create')
  async create(@Req() request: FastifyRequest) {
    const data = await this.products.validate(requestData(request), null, false);
    const row = await this.products.create(data, actor(request), auditContext(request, this.env));
    return this.products.writePayload(row);
  }

  /** The detail, with stock at the branch asked for -- looked up twice, as the view does. */
  @Get('products/:pk/')
  @Action('retrieve')
  async retrieve(
    @Param('pk') pk: string,
    @Params() query: QueryDict,
    @Req() request: FastifyRequest,
  ) {
    const product = await this.products.find(lookupParam(pk), query);
    await this.products.find(product.id, query);
    const context = await this.products.stockContext(
      product,
      request.user as RequestUser,
      query.get('branch') ?? null,
    );
    return this.products.detail(product, context);
  }

  @Put('products/:pk/')
  @Action('update')
  update(@Param('pk') pk: string, @Params() query: QueryDict, @Req() request: FastifyRequest) {
    return this.save(pk, query, request, false);
  }

  @Patch('products/:pk/')
  @Action('partial_update')
  partialUpdate(
    @Param('pk') pk: string,
    @Params() query: QueryDict,
    @Req() request: FastifyRequest,
  ) {
    return this.save(pk, query, request, true);
  }

  private async save(pk: string, query: QueryDict, request: FastifyRequest, partial: boolean) {
    const instance = await this.products.find(lookupParam(pk), query);
    const data = await this.products.validate(requestData(request), instance, partial);
    const row = await this.products.update(
      instance,
      data,
      actor(request),
      auditContext(request, this.env),
    );
    return this.products.writePayload(row);
  }

  @Delete('products/:pk/')
  @Action('destroy')
  @HttpCode(204)
  async destroy(
    @Param('pk') pk: string,
    @Params() query: QueryDict,
    @Req() request: FastifyRequest,
  ): Promise<void> {
    const product = await this.products.find(lookupParam(pk), query);
    await this.products.destroy(product, actor(request), auditContext(request, this.env));
  }

  @Post('products/:pk/generate-variants/')
  @Action('generate_variants')
  async generateVariants(
    @Param('pk') pk: string,
    @Params() query: QueryDict,
    @Req() request: FastifyRequest,
  ) {
    const product = await this.products.find(lookupParam(pk), query);
    const data = await this.products.validateGenerate(requestData(request));
    const context = auditContext(request, this.env);
    const created = data.single
      ? await this.products.createSingle(product, data.price, data.cost, actor(request), context)
      : await this.products.generate(
          product,
          data.selections,
          data.price,
          data.cost,
          actor(request),
          context,
        );
    return {
      created: created.length,
      variants: await this.products.variantPayloads(product, created),
    };
  }

  @Post('products/:pk/publish/')
  @Action('publish')
  @HttpCode(200)
  async publish(
    @Param('pk') pk: string,
    @Params() query: QueryDict,
    @Req() request: FastifyRequest,
  ) {
    const product = await this.products.find(lookupParam(pk), query);
    const row = await this.products.publish(
      product,
      actor(request),
      auditContext(request, this.env),
    );
    return this.products.detail(row, null);
  }

  @Post('products/:pk/unpublish/')
  @Action('unpublish')
  @HttpCode(200)
  async unpublish(@Param('pk') pk: string, @Params() query: QueryDict) {
    const product = await this.products.find(lookupParam(pk), query);
    return this.products.detail(await this.products.unpublish(product), null);
  }
}
