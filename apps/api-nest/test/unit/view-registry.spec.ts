import { Controller, Get, Post } from '@nestjs/common';
import { type DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';

import { AllowAny, CustomerOnly, SkipAuthentication } from '../../src/auth/authentication';
import { SkipThrottle, ThrottleScope } from '../../src/auth/throttle';
import { routePattern, ViewRegistry } from '../../src/auth/view-registry';

@Controller('api/v1/shop')
class Shop {
  @Get('things/')
  @AllowAny()
  list() {}

  @Post('things/')
  @AllowAny()
  @ThrottleScope('checkout')
  create() {}

  @Get('account/things/')
  @CustomerOnly()
  mine() {}

  @Get('account/things/:pk/')
  @CustomerOnly()
  one() {}

  // Not a route: no path of its own.
  helper() {}
}

@Controller('api')
@SkipAuthentication()
@SkipThrottle()
class Plain {
  @Get('health/')
  health() {}
}

@Controller('api/v1')
class SignedIn {
  @Get(['me/', 'myself/'])
  me() {}
}

function registry(...controllers: (new () => object)[]): ViewRegistry {
  const discovery = {
    getControllers: () => controllers.map((metatype) => ({ instance: new metatype(), metatype })),
  } as unknown as DiscoveryService;
  const views = new ViewRegistry(discovery, new MetadataScanner(), new Reflector());
  views.onModuleInit();
  return views;
}

describe('the view at a route pattern', () => {
  const views = registry(Shop, Plain, SignedIn);

  it('writes a pattern as Fastify registers it', () => {
    expect(routePattern('api/v1/shop', 'things/')).toBe('/api/v1/shop/things');
    expect(routePattern('/api/', '/health/')).toBe('/api/health');
    expect(routePattern('api/v1', ':pk/')).toBe('/api/v1/:pk');
    expect(routePattern('', '')).toBe('/');
  });

  it('answers what every handler under the pattern asks for', () => {
    expect(views.at('/api/v1/shop/account/things')).toEqual({
      access: { skipAuthentication: false, allowAny: false, customerOnly: true },
      throttle: { skip: false, onlyScoped: false, scope: undefined },
    });
    expect(views.at('/api/v1/shop/account/things/:pk/').access?.customerOnly).toBe(true);
  });

  it("reads a controller's own decorators, and a handler's first", () => {
    expect(views.at('/api/health')).toEqual({
      access: { skipAuthentication: true, allowAny: true, customerOnly: false },
      throttle: { skip: true, onlyScoped: false, scope: undefined },
    });
  });

  it('a view with no decorator asks for a signed-in user', () => {
    expect(views.at('/api/v1/me').access).toEqual({
      skipAuthentication: false,
      allowAny: false,
      customerOnly: false,
    });
    expect(views.at('/api/v1/myself/').access?.allowAny).toBe(false);
  });

  it('claims nothing where the handlers disagree, or where there is no controller', () => {
    // Two handlers, one scope between them: who may call is agreed, the throttle is not.
    expect(views.at('/api/v1/shop/things')).toEqual({
      access: { skipAuthentication: false, allowAny: true, customerOnly: false },
    });
    expect(views.at('/api/v1/nope')).toEqual({});
    expect(views.at('/api/v1/shop/helper')).toEqual({});
  });
});
