import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  NotFoundException,
  SetMetadata,
  applyDecorators,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';

import { AuthenticationRequired, PermissionDenied } from '../common/errors';
import { parseUuid } from '../common/uuid';
import { ENV, Env } from '../config/env';
import { Database } from '../database/database.service';
import { negotiate } from '../http/negotiation';
import { PLAIN_VIEWS } from '../http/pipeline';
import { RouteRegistry } from '../http/routes';
import { passwordFingerprint, TokenError, verifyAccessToken } from './jwt';
import {
  ACTION_METADATA,
  RolePermissions,
  STAFF_VIEW_METADATA,
  type StaffViewMeta,
} from './permissions';

export interface RequestUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  isActive: boolean;
  isStaff: boolean;
  isSuperuser: boolean;
  status: string;
  roleId: string | null;
  /** `user.role.code`, or null for an account without a role. */
  roleCode: string | null;
  branchId: string | null;
  organizationId: string | null;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by `AuthGuard`: the authenticated user, or null for an anonymous request. */
    user: RequestUser | null;
  }
}

const ALLOW_ANY = 'rangon:allow-any';
const SKIP_AUTHENTICATION = 'rangon:skip-authentication';
const CUSTOMER_ONLY = 'rangon:customer-only';

/** DRF `permission_classes = [AllowAny]`: authentication still runs, and can still refuse. */
export const AllowAny = () => SetMetadata(ALLOW_ANY, true);

/**
 * `authentication_classes = []` and no permission check: a plain Django view
 * such as the health checks, or a webhook that authenticates by signature.
 */
export const SkipAuthentication = () =>
  applyDecorators(SetMetadata(SKIP_AUTHENTICATION, true), SetMetadata(ALLOW_ANY, true));

/**
 * `permission_classes = [IsAuthenticated, IsCustomer]`: a signed-in customer
 * account (`accounts.permissions.IsCustomer`); anyone else signed in is 403.
 */
export const CustomerOnly = () => SetMetadata(CUSTOMER_ONLY, true);

/** What a view says about who may call it. */
export interface AccessMeta {
  /** `authentication_classes = []`: nobody is authenticated, so no token is refused. */
  skipAuthentication: boolean;
  /** `AllowAny`. */
  allowAny: boolean;
  /** `IsCustomer`, after `IsAuthenticated`. */
  customerOnly: boolean;
}

/** A handler's access metadata, the handler's own before its controller's. */
export function accessMeta(
  reflector: Reflector,
  targets: Parameters<Reflector['getAllAndOverride']>[1],
): AccessMeta {
  return {
    skipAuthentication: Boolean(reflector.getAllAndOverride<boolean>(SKIP_AUTHENTICATION, targets)),
    allowAny: Boolean(reflector.getAllAndOverride<boolean>(ALLOW_ANY, targets)),
    customerOnly: Boolean(reflector.getAllAndOverride<boolean>(CUSTOMER_ONLY, targets)),
  };
}

/** Python `bytes.split()`: runs of ASCII whitespace, empty pieces dropped. */
function splitHeader(value: string): string[] {
  return value.split(/[ \t\n\r\v\f]+/).filter(Boolean);
}

/**
 * SimpleJWT's `JWTAuthentication`, statement for statement.
 *
 * Refusals keep the Django API's status and code (401 `AUTHENTICATION_REQUIRED`).
 * The messages are SimpleJWT's own words, not the Python `repr` of its error
 * dict that the Django API currently prints -- see
 * docs/architecture/nest-port.md, "Deliberate differences".
 */
@Injectable()
export class Authenticator {
  constructor(
    private readonly db: Database,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async authenticate(request: FastifyRequest): Promise<RequestUser | null> {
    const header = request.headers.authorization;
    if (header === undefined) return null;

    const parts = splitHeader(header);
    if (parts.length === 0) return null;
    // Any other scheme is "not a JSON web token", so not this authenticator's business.
    if (parts[0] !== 'Bearer') return null;
    if (parts.length !== 2) {
      throw new AuthenticationRequired(
        'Authorization header must contain two space-delimited values',
      );
    }

    let claims;
    try {
      claims = verifyAccessToken(parts[1] as string, this.env.jwtSigningKey);
    } catch (error) {
      if (error instanceof TokenError) {
        throw new AuthenticationRequired('Given token not valid for any token type');
      }
      throw error;
    }

    const userId = claims.user_id;
    if (userId === undefined) {
      throw new AuthenticationRequired('Token contained no recognizable user identification');
    }

    // A validly signed token naming something that is not a UUID can only come
    // from a holder of the signing key; it matches no user.
    const id = parseUuid(String(userId));
    if (!id) throw new AuthenticationRequired('User not found');

    const row = await this.db.one<RequestUser & { password: string }>(
      `SELECT u.id, u.email, u.first_name AS "firstName", u.last_name AS "lastName",
              u.is_active AS "isActive", u.is_staff AS "isStaff", u.is_superuser AS "isSuperuser",
              u.status, u.role_id AS "roleId", r.code AS "roleCode", u.branch_id AS "branchId",
              u.organization_id AS "organizationId", u.password
         FROM accounts_user u
         LEFT JOIN accounts_role r ON r.id = u.role_id
        WHERE u.id = $1::uuid`,
      [id],
    );
    if (!row) throw new AuthenticationRequired('User not found');
    if (!row.isActive) throw new AuthenticationRequired('User is inactive');
    // CHECK_REVOKE_TOKEN: a password change ends every session at once (D86).
    if (claims.hash_password !== passwordFingerprint(row.password)) {
      throw new AuthenticationRequired("The user's password has been changed.");
    }

    const { password: _password, ...user } = row;
    return user;
  }
}

/**
 * Authentication, then the permission check, in DRF's order and on every
 * route: `APIView.initial()` authenticates before it looks at the method or
 * the permission classes, so a bad token is a 401 even on a public endpoint.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly authenticator: Authenticator,
    private readonly permissions: RolePermissions,
    private readonly routes: RouteRegistry,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const targets = [context.getHandler(), context.getClass()];

    // Fastify chose this route by method; Django would have resolved the
    // path to a more literal one that does not take the method. Answered as
    // a path with no route for it (`EnvelopeFilter.noRoute`).
    const url = request.raw.url ?? request.url;
    const question = url.indexOf('?');
    const resolved = this.routes.resolve(question === -1 ? url : url.slice(0, question));
    if (resolved !== undefined && resolved !== request.routeOptions.url)
      throw new NotFoundException();

    request.user = null;
    // `APIView.initial()` settles the response's format before it authenticates.
    const pattern = request.routeOptions.url ?? '';
    if (!PLAIN_VIEWS.has(pattern)) negotiate(request, pattern, this.env);
    if (this.reflector.getAllAndOverride<boolean>(SKIP_AUTHENTICATION, targets)) return true;

    request.user = await this.authenticator.authenticate(request);

    if (this.reflector.getAllAndOverride<boolean>(ALLOW_ANY, targets)) return true;
    // DRF's default: IsAuthenticated, and NotAuthenticated when nobody is.
    if (!request.user) {
      throw new AuthenticationRequired('Authentication credentials were not provided.');
    }
    if (
      this.reflector.getAllAndOverride<boolean>(CUSTOMER_ONLY, targets) &&
      request.user.roleCode !== 'CUSTOMER'
    ) {
      throw new PermissionDenied();
    }
    // `RolePermission`, after `IsAuthenticated`, on every staff view.
    const view = this.reflector.get<StaffViewMeta | undefined>(
      STAFF_VIEW_METADATA,
      context.getClass(),
    );
    if (view) {
      const action = this.reflector.get<string | undefined>(ACTION_METADATA, context.getHandler());
      if (
        !(await this.permissions.allows(
          request.user,
          view.required,
          action ?? null,
          request.method,
        ))
      )
        throw new PermissionDenied();
    }
    return true;
  }
}
