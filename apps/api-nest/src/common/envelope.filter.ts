import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { Authenticator } from '../auth/authentication';
import { RolePermissions, staffViewFor } from '../auth/permissions';
import { Throttles } from '../auth/throttle';
import { ViewRegistry } from '../auth/view-registry';
import { CSV_RENDERER, csvFallback, negotiate } from '../http/negotiation';
import { allowedMethods, markShortCircuit, PLAIN_VIEWS, plainViewRefusal } from '../http/pipeline';
import { RouteRegistry } from '../http/routes';
import { ENV, Env } from '../config/env';
import {
  AuthenticationRequired,
  BusinessError,
  MethodNotAllowed,
  PermissionDenied,
  RouteNotMatched,
} from './errors';
import { NOT_FOUND_PAGE } from './http';

/**
 * One error shape for the whole API, as `core.handlers.rangon_exception_handler`
 * writes it:
 *
 *     { "error": { "code", "message", "details", "request_id" } }
 *
 * Never a stack trace, a SQL fragment or a driver message (CLAUDE.md section 7).
 * A request no route matches is answered the way Django's resolver answers it:
 * 405 when the path exists for another method, else Django's HTML 404. (The
 * APPEND_SLASH redirect happens earlier, in `installPipeline`.)
 */
@Catch()
@Injectable()
export class EnvelopeFilter implements ExceptionFilter {
  private readonly logger = new Logger('rangon.api');
  private readonly allowCache = new Map<string, string | null>();

  constructor(
    private readonly adapterHost: HttpAdapterHost,
    private readonly routes: RouteRegistry,
    private readonly authenticator: Authenticator,
    private readonly permissions: RolePermissions,
    private readonly views: ViewRegistry,
    private readonly throttles: Throttles,
    @Inject(ENV) private readonly env: Env,
  ) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<FastifyRequest>();
    const reply = http.getResponse<FastifyReply>();

    // Nest raises this only when no route matched: this API's own handlers
    // throw `NotFound`, which is a BusinessError.
    if (exception instanceof NotFoundException) {
      void this.noRoute(request, reply);
      return;
    }
    if (exception instanceof RouteNotMatched) {
      markShortCircuit(request);
      void reply
        .status(404)
        .header('content-type', 'text/html; charset=utf-8')
        .send(NOT_FOUND_PAGE);
      return;
    }
    this.send(request, reply, exception);
  }

  private send(request: FastifyRequest, reply: FastifyReply, exception: unknown): void {
    const { status, code, message, details } = this.describe(exception, request);
    const body: Record<string, unknown> = { code, message, details };
    if (request.id) body.request_id = request.id;
    // No `WWW-Authenticate` on a 401: DRF sets it only in its default
    // exception handler, which `core.handlers` replaces.
    // A view whose CSV renderer was negotiated answers its errors through it
    // too, and that renderer renders nothing: the body is the dict's one key.
    if (request.acceptedRenderer === CSV_RENDERER) {
      void reply
        .status(status)
        .header('content-type', 'text/csv; charset=utf-8')
        .send(csvFallback({ error: body }));
      return;
    }
    void reply.status(status).header('content-type', 'application/json').send({ error: body });
  }

  private async noRoute(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const url = request.raw.url ?? request.url;
    const question = url.indexOf('?');
    const path = question === -1 ? url : url.slice(0, question);

    // The path exists for some other method: DRF still settles the format,
    // runs the view's authentication and permission checks and counts the
    // request against its throttles first, and puts `Allow` on whatever it
    // answers. A staff view's `RolePermission` sees no action
    // here, so it reads the method's name, and a signed-in owner reaches
    // the 405 where a manager is refused with a 403.
    const pattern = this.routes.match(path)[0]?.pattern;
    if (pattern !== undefined && PLAIN_VIEWS.has(pattern)) {
      plainViewRefusal(request, reply, this.env);
      return;
    }
    if (pattern !== undefined) {
      const fastify = this.adapterHost.httpAdapter.getInstance<FastifyInstance>();
      const allow = allowedMethods(fastify, pattern, this.allowCache);
      if (allow) reply.header('allow', allow);
      try {
        negotiate(request, pattern, this.env);
        const meta = this.views.at(pattern);
        const user = meta.access?.skipAuthentication
          ? null
          : await this.authenticator.authenticate(request);
        const view = staffViewFor(pattern);
        if (view) {
          if (!user)
            throw new AuthenticationRequired('Authentication credentials were not provided.');
          if (!(await this.permissions.allows(user, view.required, null, request.method)))
            throw new PermissionDenied();
        } else if (meta.access && !meta.access.allowAny) {
          // `IsAuthenticated`, and `IsCustomer` where the view asks for it.
          if (!user)
            throw new AuthenticationRequired('Authentication credentials were not provided.');
          if (meta.access.customerOnly && user.roleCode !== 'CUSTOMER')
            throw new PermissionDenied();
        }
        // The throttles count a request before DRF looks for its handler.
        if (meta.throttle) {
          request.user = user;
          await this.throttles.check(request, meta.throttle);
        }
      } catch (error) {
        this.send(request, reply, error);
        return;
      }
      this.send(request, reply, new MethodNotAllowed(request.method));
      return;
    }
    void reply.status(404).header('content-type', 'text/html; charset=utf-8').send(NOT_FOUND_PAGE);
  }

  private describe(
    exception: unknown,
    request: FastifyRequest,
  ): { status: number; code: string; message: string; details: unknown } {
    // 1. Our own domain errors -- the common, expected case.
    if (exception instanceof BusinessError) {
      return {
        status: exception.statusCode,
        code: exception.code,
        message: exception.message,
        details: exception.details,
      };
    }

    // 2. What Fastify itself refuses before a handler runs.
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      if (status === 400) {
        return { status, code: 'VALIDATION_ERROR', message: 'Invalid input.', details: {} };
      }
      if (status === 413) {
        return {
          status,
          code: 'VALIDATION_ERROR',
          message: 'Request body too large.',
          details: {},
        };
      }
      if (status === 415) {
        return {
          status,
          code: 'UNSUPPORTED_MEDIA_TYPE',
          message: `Unsupported media type "${request.headers['content-type'] ?? ''}" in request.`,
          details: {},
        };
      }
    }

    // 3. A constraint fired -- the database defended an invariant the service
    //    should have caught first. Log loudly, tell the client nothing useful.
    if (isIntegrityViolation(exception)) {
      this.logger.error(`Integrity error escaped the service layer: ${String(exception)}`);
      return {
        status: 409,
        code: 'CONFLICT',
        message: 'The request conflicts with the current state of the data.',
        details: {},
      };
    }

    // 4. Anything else: 500 with no internals leaked.
    this.logger.error(
      `Unhandled exception on ${request.method} ${request.url}`,
      exception instanceof Error ? exception.stack : String(exception),
    );
    return {
      status: 500,
      code: 'SERVER_ERROR',
      message: 'An unexpected error occurred. Quote the request id when reporting this.',
      details: {},
    };
  }
}

/** PostgreSQL SQLSTATE class 23: integrity constraint violation. */
function isIntegrityViolation(exception: unknown): boolean {
  const code = (exception as { code?: unknown } | null)?.code;
  return typeof code === 'string' && code.startsWith('23') && code.length === 5;
}
