import { Get, Inject, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';

import type { RequestUser } from '../auth/authentication';
import { RolePermissions, StaffView } from '../auth/permissions';
import { Dec } from '../common/decimal';
import { csvDictWriter } from '../common/pycsv';
import { Params, QueryDict } from '../common/query-dict';
import { ENV, Env } from '../config/env';
import { CSV_RENDERER, csvFallback, declareRenderers, JSON_RENDERER } from '../http/negotiation';
import { type DateRange, dateRangeFromParams } from './date-range';
import { csvCell, Dcm, type Payload, ReportsService, type Row, toJson } from './reports.service';

/**
 * `reports.api.views`: eleven views over `reports.services`, each a
 * `BaseReportView` with its own permission, report and file name.
 *
 * `renderer_classes = [JSONRenderer, CSVRenderer]`, and the CSV renderer
 * renders nothing. So `?format=csv` on a reader who may export is a plain
 * `text/csv` download, written by hand -- and every other answer that
 * negotiated CSV (an `Accept: text/csv` with no `format`, or any refusal
 * under `?format=csv`) is the keys of the dict it would have been, run
 * together: `results`, or `error` (D231, copied).
 */
declareRenderers('reports', [JSON_RENDERER, CSV_RENDERER]);

const VIEW = ['reports.view'] as const;
const FINANCIAL = ['reports.financial'] as const;

type Data = Row[] | Payload;
interface Scope {
  range: DateRange;
  branchId: string | null;
}

/** `BaseReportView.csv_rows`: a list exports itself, a dict its `daily` rows. */
function defaultCsvRows(data: Data): Row[] {
  return Array.isArray(data) ? data : ((data.daily as Row[] | undefined) ?? []);
}

/** Python's `-value` on a Decimal: a zero stays an unsigned zero. */
function negated(value: Dcm): Dcm {
  const bare = value.text.replace(/^-/, '');
  if (new Dec(value.text).isZero()) return new Dcm(bare);
  return new Dcm(value.text.startsWith('-') ? bare : `-${value.text}`);
}

abstract class ReportView {
  constructor(
    protected readonly reports: ReportsService,
    protected readonly permissions: RolePermissions,
    @Inject(ENV) protected readonly env: Env,
  ) {}

  /** `_csv_response(rows, filename)`. */
  protected csv(reply: FastifyReply, rows: Row[], filename: string): string {
    void reply
      .header('content-type', 'text/csv')
      .header('content-disposition', `attachment; filename="${filename}"`);
    const [first] = rows;
    if (!first) return '';
    return csvDictWriter(
      Object.keys(first),
      rows.map((row) =>
        Object.fromEntries(Object.entries(row).map(([key, cell]) => [key, csvCell(cell)])),
      ),
    );
  }

  /** A `Response(body)`, through whichever renderer the request negotiated. */
  protected respond(
    request: FastifyRequest,
    reply: FastifyReply,
    body: Record<string, unknown>,
    status = 200,
  ): unknown {
    void reply.status(status);
    if (request.acceptedRenderer !== CSV_RENDERER) return body;
    void reply.header('content-type', 'text/csv; charset=utf-8');
    return csvFallback(body);
  }

  /**
   * `BaseReportView.get`: the branch, then the window, then the report; and
   * only then, for `?format=csv`, whether the reader may export.
   */
  protected async serve(
    request: FastifyRequest,
    reply: FastifyReply,
    query: QueryDict,
    view: {
      filename: string;
      report: (scope: Scope, user: RequestUser) => Promise<Data>;
      needsRange?: boolean;
      csvRows?: (data: Data) => Row[];
    },
  ): Promise<unknown> {
    const user = request.user as RequestUser;
    const branchId = await this.reports.branchFor(user, query);
    // A report with no window never reads the parameters, so never refuses them.
    const range =
      view.needsRange === false
        ? { start: '', end: '', label: '' }
        : dateRangeFromParams(query, this.env.DJANGO_TIME_ZONE);
    const data = await view.report({ range, branchId }, user);

    if (query.get('format') === 'csv') {
      if (!(await this.permissions.has(user, 'reports.export'))) {
        return this.respond(
          request,
          reply,
          {
            error: {
              code: 'PERMISSION_DENIED',
              message: 'You cannot export reports.',
              details: {},
            },
          },
          403,
        );
      }
      return this.csv(reply, (view.csvRows ?? defaultCsvRows)(data), view.filename);
    }
    const payload = Array.isArray(data) ? { results: data } : data;
    return this.respond(request, reply, toJson(payload) as Record<string, unknown>);
  }
}

@StaffView('reports/dashboard', VIEW)
export class DashboardReportController extends ReportView {
  @Get('reports/dashboard/')
  get(
    @Params() query: QueryDict,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.serve(request, reply, query, {
      filename: 'dashboard.csv',
      // Expenses and net profit are the business summary's figures: its permission.
      report: async (scope, user) =>
        this.reports.dashboard(scope, await this.permissions.has(user, 'reports.financial')),
    });
  }
}

@StaffView('reports/sales', VIEW)
export class SalesReportController extends ReportView {
  /**
   * `SalesReportView.get`, written out on its own: the window is read before
   * the branch, the refusal to export is a bare `detail`, and the rows go to
   * DRF's encoder as they are -- a Decimal there is a JSON number.
   */
  @Get('reports/sales/')
  async get(
    @Params() query: QueryDict,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const user = request.user as RequestUser;
    const range = dateRangeFromParams(query, this.env.DJANGO_TIME_ZONE);
    const branchId = await this.reports.branchFor(user, query);
    const rows = await this.reports.sales({ range, branchId }, query.get('channel', ''));
    if (query.get('format') === 'csv') {
      if (!(await this.permissions.has(user, 'reports.export'))) {
        return this.respond(request, reply, { detail: 'Export not permitted.' }, 403);
      }
      return this.csv(reply, rows, 'sales.csv');
    }
    return this.respond(request, reply, { results: toJson(rows, true) });
  }
}

@StaffView('reports/products/performance', VIEW)
export class ProductPerformanceReportController extends ReportView {
  @Get('reports/products/performance/')
  get(
    @Params() query: QueryDict,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.serve(request, reply, query, {
      filename: 'product-performance.csv',
      report: (scope) => this.reports.productPerformance(scope),
    });
  }
}

@StaffView('reports/inventory/valuation', FINANCIAL)
export class InventoryValuationReportController extends ReportView {
  @Get('reports/inventory/valuation/')
  get(
    @Params() query: QueryDict,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.serve(request, reply, query, {
      filename: 'inventory-valuation.csv',
      needsRange: false,
      report: (scope) => this.reports.inventoryValuation(scope.branchId),
    });
  }
}

@StaffView('reports/inventory/movement', FINANCIAL)
export class InventoryMovementReportController extends ReportView {
  @Get('reports/inventory/movement/')
  get(
    @Params() query: QueryDict,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.serve(request, reply, query, {
      filename: 'inventory-movement.csv',
      report: (scope) => this.reports.inventoryMovement(scope),
    });
  }
}

@StaffView('reports/purchases', FINANCIAL)
export class PurchaseReportController extends ReportView {
  @Get('reports/purchases/')
  get(
    @Params() query: QueryDict,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.serve(request, reply, query, {
      filename: 'purchases.csv',
      report: (scope) => this.reports.purchases(scope),
    });
  }
}

@StaffView('reports/returns', VIEW)
export class ReturnsReportController extends ReportView {
  @Get('reports/returns/')
  get(
    @Params() query: QueryDict,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.serve(request, reply, query, {
      filename: 'returns.csv',
      report: (scope) => this.reports.returns(scope),
    });
  }
}

@StaffView('reports/profit', FINANCIAL)
export class ProfitReportController extends ReportView {
  @Get('reports/profit/')
  get(
    @Params() query: QueryDict,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.serve(request, reply, query, {
      filename: 'profit.csv',
      report: (scope) => this.reports.profit(scope),
    });
  }
}

@StaffView('reports/expenses', FINANCIAL)
export class ExpenseReportController extends ReportView {
  @Get('reports/expenses/')
  get(
    @Params() query: QueryDict,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.serve(request, reply, query, {
      filename: 'expenses.csv',
      report: (scope) => this.reports.expenses(scope),
    });
  }
}

@StaffView('reports/business-summary', FINANCIAL)
export class BusinessSummaryReportController extends ReportView {
  @Get('reports/business-summary/')
  get(
    @Params() query: QueryDict,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.serve(request, reply, query, {
      filename: 'business-summary.csv',
      report: (scope) => this.reports.businessSummary(scope),
      // `BusinessSummaryView.csv_rows`: the statement itself, one row per line.
      csvRows: (data) => {
        const summary = data as Payload;
        const revenue = summary.revenue as Record<string, Dcm>;
        const cost = summary.cost_of_goods as Record<string, Dcm>;
        const expenses = summary.expenses as { total: Dcm; by_category: Record<string, unknown>[] };
        const shipping = summary.purchase_shipping as { total: Dcm };
        return [
          { line: 'Revenue (goods, net of VAT)', amount: revenue.goods as Dcm },
          { line: 'Less refunds', amount: negated(revenue.refunds as Dcm) },
          { line: 'Net revenue', amount: revenue.net as Dcm },
          { line: 'Cost of goods sold', amount: negated(cost.sold as Dcm) },
          {
            line: 'Cost recovered from restocked returns',
            amount: cost.recovered_from_returns as Dcm,
          },
          { line: 'Gross profit', amount: summary.gross_profit as Dcm },
          ...expenses.by_category.map((row) => ({
            line: `Expense — ${row.category as string}`,
            amount: negated(row.total as Dcm),
          })),
          { line: 'Total expenses', amount: negated(expenses.total) },
          { line: 'Purchase order shipping', amount: negated(shipping.total) },
          { line: 'Net profit', amount: summary.net_profit as Dcm },
          { line: 'VAT collected (held, not income)', amount: revenue.vat_collected as Dcm },
        ];
      },
    });
  }
}

@StaffView('reports/vat', FINANCIAL)
export class VatReportController extends ReportView {
  @Get('reports/vat/')
  get(
    @Params() query: QueryDict,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.serve(request, reply, query, {
      filename: 'vat-return.csv',
      report: (scope) => this.reports.vat(scope),
      // A filing is per month: the month rows are the tabular part.
      csvRows: (data) => ((data as Payload).monthly as Row[] | undefined) ?? [],
    });
  }
}
