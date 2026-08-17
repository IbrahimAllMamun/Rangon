# Retail + E-commerce Store Management System — End-to-End Build Plan

## 0. Purpose

Build a production-ready **omnichannel retail platform** for a fashion/general retail business selling:

- Clothing
- Shoes
- Backpacks and bags
- Cosmetics
- Accessories
- Future product categories

The system must support both:

1. **Physical store operations**
   - POS
   - Barcode scanning
   - Cash/card/mobile payments
   - Receipts
   - Returns
   - Inventory

2. **Online commerce**
   - Public e-commerce storefront
   - Product catalog
   - Search/filter
   - Cart
   - Checkout
   - Online payments
   - Cash on delivery
   - Customer accounts
   - Orders
   - Shipping
   - Reviews
   - Wishlist
   - Coupons

3. **Back-office management**
   - Products
   - Product variants
   - Inventory
   - Purchasing
   - Suppliers
   - Customers
   - Employees
   - Reports
   - Accounting-oriented transaction records
   - Audit logs
   - Settings

The central architectural principle is:

> **Physical POS, online store, and admin panel must use the same backend, product catalog, inventory ledger, customer database, and order system.**

Do not build separate inventory systems for online and physical sales.

---

# 1. Product Vision

The final system should behave like a small retail ERP + POS + e-commerce platform.

```text
                         ┌─────────────────────┐
                         │    ONLINE STORE     │
                         │       Next.js      │
                         └──────────┬──────────┘
                                    │
                                    │
┌─────────────────┐       ┌────────▼──────────┐       ┌─────────────────┐
│  PHYSICAL POS   │──────►│      BACKEND      │◄──────│   ADMIN PANEL   │
│                 │       │      Django       │       │                 │
│ Barcode         │       │       DRF         │       │ Products        │
│ Sales           │       │ Business Logic    │       │ Inventory       │
│ Payments        │       │ Permissions       │       │ Purchases       │
│ Returns         │       │                   │       │ Reports         │
└─────────────────┘       └────────┬──────────┘       └─────────────────┘
                                   │
                          ┌────────▼────────┐
                          │   PostgreSQL    │
                          │                 │
                          │ Products        │
                          │ Inventory       │
                          │ Orders          │
                          │ Customers       │
                          │ Payments        │
                          └─────────────────┘
```

---

# 2. Recommended Technology Stack

## Frontend

- Next.js
- TypeScript
- Tailwind CSS
- shadcn/ui
- TanStack Query
- Zustand where client-side state is actually required
- React Hook Form
- Zod
- TanStack Table
- next/image
- Playwright for E2E testing

## Backend

- Python
- Django
- Django REST Framework
- PostgreSQL
- Celery for asynchronous/background jobs
- Redis for caching, queues, rate limiting, and temporary jobs where appropriate

## Infrastructure

- Docker
- Docker Compose for local development
- GitHub Actions
- PostgreSQL automated backups
- Object storage for product images
- CDN where useful
- HTTPS
- Environment-specific configuration

## Optional future desktop packaging

- Tauri for a Windows POS wrapper

Do not start with Tauri. Build the POS as a web/PWA interface first.

---

# 3. Architectural Principles

The AI agent MUST follow these principles throughout development.

## 3.1 Single source of truth

Products, variants, customers, inventory, orders, payments, and transactions must live in the backend.

The frontend must never become the authoritative source.

## 3.2 Inventory is ledger-driven

Never casually modify stock with arbitrary `quantity = quantity - 1` operations.

Every inventory change must have a reason and transaction record.

Example:

```text
PURCHASE       +50
SALE            -2
RETURN          +1
DAMAGE          -1
ADJUSTMENT      +3
TRANSFER        -5
```

## 3.3 Never hard-delete financial/transaction records

Sales, payments, purchases, returns, and inventory transactions should normally be immutable.

Use:

- cancellation
- reversal
- refund
- adjustment
- status changes

instead of deleting historical records.

## 3.4 Backend owns business rules

The frontend can hide buttons, but permissions and business rules must always be enforced by the backend.

## 3.5 Every important action is auditable

Track:

- who
- what
- when
- before
- after
- reason
- source/reference

## 3.6 Design for multi-branch

Even if V1 has one store, database architecture should support:

```text
Organization
  └── Branch
        └── Inventory
```

Do not build a one-branch architecture that must later be rewritten.

## 3.7 Design for omnichannel commerce

An order must have a channel.

Example:

```text
POS
ONLINE
PHONE
SOCIAL
OTHER
```

Online and physical orders should share core order concepts.

---

# 4. Repository Structure

Prefer a monorepo.

```text
retail-platform/
│
├── apps/
│   ├── web/
│   │   ├── storefront/
│   │   ├── admin/
│   │   └── pos/
│   │
│   └── api/
│
├── packages/
│   ├── ui/
│   ├── types/
│   ├── config/
│   └── validation/
│
├── infrastructure/
│   ├── docker/
│   ├── nginx/
│   └── deployment/
│
├── docs/
│   ├── architecture/
│   ├── api/
│   ├── database/
│   ├── decisions/
│   └── operations/
│
├── scripts/
│
├── tests/
│
├── CLAUDE.md
├── README.md
└── docker-compose.yml
```

The exact structure may be adjusted after the architecture phase, but the agent must document any deviation.

---

# 5. Development Rules for the AI Agent

The AI agent must NOT attempt to build the entire application in one giant step.

For every phase:

1. Read existing architecture and project state.
2. Understand dependencies.
3. Create/update design documentation.
4. Implement the smallest coherent unit.
5. Write tests.
6. Run lint/type checks.
7. Run relevant tests.
8. Fix failures.
9. Update documentation.
10. Commit a coherent change.
11. Report what changed and what remains.

Do not silently skip tests.

Do not replace working architecture merely because another technology looks newer.

Do not introduce dependencies without explaining why they are necessary.

Do not build placeholder business logic and leave it undocumented.

---

# 6. Phase 0 — Project Constitution and AI-Agent Rules

## Objective

Create the project's permanent instructions.

Create:

```text
CLAUDE.md
docs/architecture/architecture.md
docs/architecture/decisions/
docs/database/
docs/api/
docs/operations/
```

`CLAUDE.md` should define:

- Project purpose
- Tech stack
- Architecture rules
- Naming conventions
- Testing requirements
- Security requirements
- Database rules
- API conventions
- Git conventions
- UI conventions
- Accessibility requirements
- Definition of done
- Prohibited shortcuts

## Definition of done

- Repository initialized
- CLAUDE.md created
- README created
- Architecture documentation created
- Development commands documented
- CI skeleton created

---

# 7. Phase 1 — Architecture and Domain Modeling

Before building screens, model the business.

Create:

- System architecture diagram
- ER diagram
- Domain model
- Order lifecycle
- Inventory lifecycle
- Purchase lifecycle
- Return lifecycle
- Payment lifecycle
- User/permission model
- Multi-branch model
- Online checkout lifecycle

## Main domains

```text
Organization
Branch
User
Role
Permission

Category
Brand
Product
ProductVariant
Attribute
AttributeValue
ProductImage

Supplier
Purchase
PurchaseItem

Inventory
InventoryTransaction
StockAdjustment
StockTransfer

Customer
CustomerAddress

Order
OrderItem
Payment
Refund
Return
ReturnItem

Shipment
ShipmentEvent

Coupon
Promotion

Wishlist
WishlistItem
Review

AuditLog
Notification
```

## Definition of done

All relationships are documented before implementing the production schema.

---

# 8. Phase 2 — Database Foundation

Implement PostgreSQL schema through Django migrations.

## Core tables

### Organization

```text
id
name
slug
status
created_at
updated_at
```

### Branch

```text
id
organization_id
name
code
address
phone
status
created_at
updated_at
```

### User

Use Django's authentication foundation.

Add:

```text
organization
branch
role
status
```

## Product hierarchy

```text
Category
Brand
Product
ProductVariant
Attribute
AttributeValue
ProductVariantAttribute
ProductImage
```

## Important rule

A product is a conceptual item.

A variant is the actual sellable SKU.

Example:

```text
Product:
Men's Polo Shirt

Variants:
POL-BLK-M
POL-BLK-L
POL-WHT-M
POL-WHT-L
```

## Definition of done

- Migrations work from an empty database.
- Seed data can be loaded.
- Constraints and indexes are documented.
- Foreign keys are correct.
- Unique constraints are defined.
- No business-critical field relies on frontend validation only.

---

# 9. Phase 3 — Authentication, Authorization, and Audit

Implement:

- Login
- Logout
- Session/token strategy
- Password management
- Role-based access control
- Permission checks
- User activation/deactivation
- Branch access
- Audit logs

## Initial roles

```text
OWNER
ADMIN
MANAGER
CASHIER
INVENTORY_MANAGER
ACCOUNTANT
CUSTOMER
```

## Example permission model

```text
products.view
products.create
products.update
products.delete

inventory.view
inventory.adjust
inventory.transfer

sales.create
sales.refund

purchases.create

reports.view

users.manage
settings.manage
```

## Audit log

Record sensitive actions:

```text
user
action
entity_type
entity_id
old_values
new_values
reason
ip_address
created_at
```

Do not log secrets or passwords.

---

# 10. Phase 4 — Product Catalog Management

Build the complete product management system.

## Product fields

```text
name
slug
description
short_description
category
brand
status
featured
published
seo_title
seo_description
created_at
updated_at
```

## Variant fields

```text
sku
barcode
price
cost
compare_at_price
weight
status
```

## Dynamic attributes

Support categories such as:

### Clothing

```text
Size
Color
Material
Gender
Fit
```

### Shoes

```text
Size
Color
Material
Gender
```

### Cosmetics

```text
Shade
Volume
Batch
Expiry
```

### Bags

```text
Color
Capacity
Material
```

Do not hard-code category-specific columns into the product table.

---

# 11. Phase 5 — Product Media and Content

Implement:

- Multiple product images
- Primary image
- Image ordering
- Alt text
- Image optimization
- Object storage integration
- Product gallery
- Variant-specific images where useful

The storefront must use optimized responsive images.

---

# 12. Phase 6 — Inventory Engine

This is one of the highest-risk modules.

Build inventory before POS and online checkout.

## Inventory model

At minimum:

```text
branch_id
variant_id
on_hand
reserved
available
```

Where:

```text
available = on_hand - reserved
```

Do not allow negative available stock unless a deliberate business configuration explicitly permits overselling.

## Inventory transactions

Types:

```text
PURCHASE
SALE
RETURN
DAMAGE
LOSS
ADJUSTMENT
TRANSFER_IN
TRANSFER_OUT
RESERVATION
RESERVATION_RELEASE
```

Each transaction must contain:

```text
variant
branch
quantity
transaction_type
reference_type
reference_id
created_by
created_at
notes
```

## Critical invariant

Inventory must remain mathematically consistent.

Every stock-changing operation must be atomic.

Use database transactions and appropriate locking/concurrency controls.

---

# 13. Phase 7 — Supplier and Purchasing

Implement:

```text
Supplier
PurchaseOrder
Purchase
PurchaseItem
SupplierPayment
```

Support:

- Supplier details
- Purchase invoice
- Purchase date
- Product/variant
- Quantity
- Unit cost
- Discount
- Tax where applicable
- Total
- Payment status
- Notes

Purchasing must increase inventory through inventory transactions.

---

# 14. Phase 8 — POS

Build a dedicated POS interface.

## POS requirements

- Fast product search
- Barcode scan
- SKU search
- Category browsing
- Cart
- Quantity changes
- Discounts
- Customer selection
- Walk-in customer
- Payment
- Split payment if supported
- Invoice/receipt
- Hold order
- Resume held order
- Sale cancellation according to permissions
- Returns
- Keyboard shortcuts

## POS UX principle

The cashier should be able to complete a common sale with minimal clicks.

---

# 15. Phase 9 — Payment System

Create a generic payment model.

```text
payment_method
amount
currency
status
reference
provider
transaction_id
paid_at
```

Methods can include:

```text
CASH
CARD
MOBILE_MFS
BANK
ONLINE_GATEWAY
COD
OTHER
```

Do not hard-code payment provider logic throughout the application.

Use a provider abstraction.

---

# 16. Phase 10 — Returns and Refunds

Build return workflow.

```text
Sale/Order
   ↓
Return Request
   ↓
Approval
   ↓
Return Received
   ↓
Inventory Decision
   ↓
Refund
```

Return reasons:

```text
WRONG_SIZE
DEFECTIVE
WRONG_PRODUCT
CUSTOMER_CHANGED_MIND
DAMAGED
OTHER
```

Support restocking decisions:

```text
RESTOCK
DAMAGED
QUARANTINE
```

Never simply delete the original sale.

---

# 17. Phase 11 — Customer Management

Implement:

```text
Customer
CustomerAddress
CustomerNote
CustomerOrderHistory
```

Support:

- Guest customers
- Registered customers
- Phone number
- Email
- Multiple addresses
- Order history
- Purchase totals
- Returns
- Loyalty readiness

Customer identity should not depend only on email.

Phone number may be an important business identifier depending on the final requirements.

---

# 18. Phase 12 — Public Online Store

Build the storefront.

## Pages

```text
/
 /shop
 /category/[slug]
 /product/[slug]
 /search
 /cart
 /checkout
 /order/[orderNumber]
 /account
 /account/orders
 /account/addresses
 /wishlist
 /login
 /register
 /about
 /contact
 /policies/*
```

## Homepage

Include:

- Hero
- Featured categories
- New arrivals
- Best sellers
- Promotions
- Featured products
- Brand sections
- Trust information

Do not overbuild animations before the core shopping flow works.

---

# 19. Phase 13 — Search and Filtering

Build product discovery.

Support:

- Name search
- SKU search for admin
- Category
- Brand
- Price range
- Size
- Color
- Availability
- Attributes
- Sorting

Possible initial implementation:

PostgreSQL search + indexed filtering.

Only introduce Elasticsearch/Meilisearch if real requirements justify it.

---

# 20. Phase 14 — Cart

Implement:

- Add item
- Remove item
- Change quantity
- Variant selection
- Stock validation
- Price validation
- Coupon application
- Shipping estimate

Do not trust prices or availability sent from the browser.

At checkout, the server must recalculate everything.

---

# 21. Phase 15 — Online Checkout

Build:

```text
Cart
 ↓
Address
 ↓
Shipping Method
 ↓
Payment Method
 ↓
Order Review
 ↓
Order Creation
 ↓
Payment
 ↓
Confirmation
```

Prevent:

- Overselling
- Duplicate orders
- Duplicate payment processing
- Price manipulation
- Coupon abuse

Use idempotency keys for payment/order operations where appropriate.

---

# 22. Phase 16 — Online Order Management

Order statuses:

```text
PENDING
CONFIRMED
PROCESSING
PACKED
SHIPPED
DELIVERED
CANCELLED
RETURN_REQUESTED
RETURNED
REFUNDED
```

Implement an order timeline.

Admin must be able to:

- View order
- Update status
- Print packing slip
- Print invoice
- View payment
- View customer
- View stock impact
- Process cancellation
- Process return

---

# 23. Phase 17 — Shipping

Build a shipping abstraction.

Entities:

```text
ShippingZone
ShippingMethod
Shipment
ShipmentEvent
Courier
```

Support initially:

- Local delivery
- Outside-area delivery
- Pickup if required
- Manual tracking number

Design the interface so courier integrations can be added later.

---

# 24. Phase 18 — Coupons and Promotions

Start simple.

Support:

```text
percentage discount
fixed discount
minimum order value
maximum discount
start date
end date
usage limit
per-customer limit
product/category scope
```

Prevent coupon manipulation on the client.

The backend calculates the final discount.

---

# 25. Phase 19 — Wishlist and Reviews

Wishlist:

```text
Wishlist
WishlistItem
```

Reviews:

```text
Review
rating
title
comment
verified_purchase
status
created_at
```

Only allow verified-purchase reviews where possible.

Moderation must exist before publishing reviews.

---

# 26. Phase 20 — Admin Dashboard

Dashboard KPIs:

```text
Today's sales
Today's orders
Gross profit
Items sold
Returns
Online sales
POS sales
Low-stock products
Pending online orders
```

Charts:

- Sales over time
- Sales by channel
- Category sales
- Payment methods
- Top products
- Inventory value

The dashboard must use server-side aggregation for large datasets.

---

# 27. Phase 21 — Reporting

Build:

## Sales report

```text
Date
Channel
Order
Customer
Subtotal
Discount
Tax
Shipping
Total
Payment
Status
```

## Product performance

```text
Product
Units sold
Revenue
Cost
Gross profit
Margin
```

## Inventory report

```text
SKU
Product
Branch
On hand
Reserved
Available
Average cost
Stock value
```

## Purchase report

```text
Supplier
Purchase
Amount
Payment status
```

## Returns report

```text
Return reason
Product
Quantity
Refund
Channel
```

Support CSV/XLSX export where useful.

---

# 28. Phase 22 — Profit and Inventory Costing

Use a clearly documented inventory costing method.

Recommended starting point:

> Weighted average cost.

For every sale:

```text
Revenue
- Cost of goods sold
= Gross profit
```

Do not calculate profit using only the current selling price minus an arbitrary product cost.

The costing method must be deterministic and documented.

---

# 29. Phase 23 — Offline POS

Only after online POS works correctly.

Implement:

```text
Service Worker
IndexedDB
Local POS cache
Offline transaction queue
Sync engine
Conflict handling
```

Offline-capable data should be limited to what POS actually needs.

When offline:

- Continue eligible sales
- Store transactions locally
- Mark them pending sync

When online:

```text
Local queue
   ↓
Sync API
   ↓
Server validation
   ↓
Atomic transaction
   ↓
Success/failure
   ↓
Local queue update
```

Do not attempt to make the entire admin system offline.

---

# 30. Phase 24 — Barcode and Printing

Support:

- USB barcode scanners
- Bluetooth scanners
- Barcode lookup
- Barcode generation
- SKU labels
- Receipt printing
- A4 invoice printing
- Thermal receipt printing

Barcode scanners usually behave like keyboards, so the POS should support keyboard-style scanner input first.

Build printer abstraction rather than tightly coupling the UI to one printer model.

---

# 31. Phase 25 — Notifications

Implement notification infrastructure.

Possible notifications:

```text
New online order
Payment received
Low stock
Out of stock
Order shipped
Order delivered
Return request
Refund completed
```

Channels:

- In-app
- Email
- SMS
- Other providers later

Use background jobs for sending.

---

# 32. Phase 26 — SEO

The online store must be search-engine friendly.

Implement:

- SSR/ISR where appropriate
- Metadata
- Open Graph
- Twitter/X cards where relevant
- Sitemap
- Robots.txt
- Canonical URLs
- Structured product data
- Breadcrumb structured data
- SEO-friendly slugs
- Fast images
- Good Core Web Vitals

Do not allow duplicate URLs for the same product unnecessarily.

---

# 33. Phase 27 — Security

Perform a dedicated security pass.

Minimum:

- Secure authentication
- Password hashing
- Authorization
- CSRF protection where applicable
- CORS configuration
- Input validation
- SQL injection protection
- XSS protection
- Rate limiting
- Secure cookies
- HTTPS
- Secret management
- File upload validation
- Permission checks
- Audit logs
- Secure payment handling
- No secrets in frontend code

Follow OWASP guidance.

---

# 34. Phase 28 — Testing Strategy

Testing is mandatory.

## Backend

- Unit tests
- Model tests
- Service tests
- API tests
- Permission tests
- Inventory tests
- Order tests
- Payment tests

## Frontend

- Component tests where useful
- Form validation tests
- State tests where useful

## E2E

Use Playwright.

Critical flows:

### POS

```text
Login
→ Scan product
→ Add to cart
→ Payment
→ Sale completed
→ Inventory decreased
```

### Online

```text
Browse
→ Product
→ Add to cart
→ Checkout
→ Order
→ Payment
→ Inventory reserved/decreased
```

### Return

```text
Order
→ Return
→ Approval
→ Refund
→ Inventory adjustment
```

### Purchase

```text
Purchase
→ Receive stock
→ Inventory increased
```

---

# 35. Phase 29 — Concurrency Testing

This is critical.

Test scenarios such as:

```text
Stock = 1

Customer A checks out
Customer B checks out simultaneously
```

The system must not accidentally sell 2 units.

Also test:

- Simultaneous POS sale and online sale
- Double-click checkout
- Payment webhook replay
- Duplicate webhook
- Reservation expiration race
- Return processed twice

Use database transactions and locking where required.

---

# 36. Phase 30 — Performance

Measure:

- API latency
- Database query count
- Product listing performance
- Checkout performance
- POS search performance
- Dashboard aggregation performance

Add indexes based on actual query patterns.

Avoid premature microservices.

This system should begin as a **modular monolith**.

Do not split Django into dozens of services.

---

# 37. Phase 31 — Observability

Implement:

- Structured application logs
- Error tracking
- Request IDs
- Audit logs
- Health endpoint
- Database health checks
- Background job monitoring
- Basic performance monitoring

Production should make failures diagnosable.

---

# 32A. Full Dockerization and Container Architecture

The entire system must be Dockerized from the beginning. The application must be reproducible on a developer machine, CI environment, staging server, and production server using containers.

## Dockerization goals

The Docker setup must provide:

- Reproducible development environments
- Identical runtime dependencies across environments
- Isolated services
- Easy onboarding for new developers
- Local PostgreSQL
- Local Redis
- Django API container
- Next.js web container
- Celery worker
- Celery beat/scheduler
- Reverse proxy where required
- Optional S3-compatible object storage for local development
- Separate development, test, staging, and production configurations

Do not install project runtime dependencies directly on the host except for basic tooling such as Git, Docker, and an editor.

## Container architecture

```text
                         Docker Compose
                              │
        ┌─────────────────────┼─────────────────────┐
        │                     │                     │
        ▼                     ▼                     ▼
   Next.js Web           Django API            Nginx
        │                     │
        │                     ├──────────────┐
        │                     │              │
        ▼                     ▼              ▼
     Browser             PostgreSQL       Redis
                                       │
                              ┌────────┴────────┐
                              ▼                 ▼
                         Celery Worker      Celery Beat
```

Recommended services:

```text
web
api
db
redis
worker
beat
nginx
```

Optional development services:

```text
minio
mailpit
```

## Docker repository structure

```text
retail-platform/
├── apps/
│   ├── web/
│   │   ├── Dockerfile
│   │   ├── Dockerfile.dev
│   │   └── ...
│   └── api/
│       ├── Dockerfile
│       ├── Dockerfile.dev
│       └── ...
├── infrastructure/
│   ├── docker/
│   │   ├── nginx/
│   │   │   ├── nginx.conf
│   │   │   └── conf.d/
│   │   └── scripts/
│   └── deployment/
├── docker-compose.yml
├── docker-compose.dev.yml
├── docker-compose.test.yml
├── docker-compose.prod.yml
├── .dockerignore
└── .env.example
```

The exact repository layout may be adjusted, but container responsibilities must remain clearly separated.

## Development Docker Compose

Create a development Compose environment that starts the complete stack with one command:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build
```

It should support:

- Next.js hot reload
- Django development server
- PostgreSQL persistence
- Redis
- Celery worker
- Celery scheduler
- Source-code volume mounts
- Local email testing
- Local object storage if enabled

## Production Docker images

Use multi-stage builds.

### Next.js

```text
Node dependency stage
        ↓
Build stage
        ↓
Minimal runtime stage
```

Prefer Next.js standalone output where appropriate.

### Django

```text
Python dependency/build stage
        ↓
Minimal runtime stage
```

Use a production WSGI/ASGI server. Never use Django's development server in production.

## PostgreSQL

Use PostgreSQL as a containerized service for development and testing. Production PostgreSQL may be managed or self-hosted with durable storage and automated backups. Never treat a disposable database container as production storage.

## Redis

Use Redis for Celery, caching, rate limiting where appropriate, and short-lived data. Redis must never become the source of truth for business-critical transactions.

## Celery

Run background jobs in separate containers: `worker` and `beat`. Examples include email, notifications, image processing, expiry checks, reservation cleanup, report generation, scheduled jobs, and low-stock notifications. Critical financial and inventory transactions must not depend on an asynchronous task completing successfully.

## Nginx / Reverse Proxy

Use Nginx or an equivalent reverse proxy where appropriate for TLS termination, HTTP→HTTPS redirect, routing, static/media serving, security headers, compression, request limits, proxy configuration, and health checks. If the hosting platform already provides a managed reverse proxy/load balancer, avoid adding Nginx unnecessarily and document the decision.

## Environment configuration

Never hard-code secrets. Use `.env.example`, `.env.development`, `.env.test`, and `.env.production`; never commit real secrets. Production secrets must come from secure secret management.

Important variables include:

```text
DATABASE_URL
POSTGRES_DB
POSTGRES_USER
POSTGRES_PASSWORD
REDIS_URL
DJANGO_SECRET_KEY
DJANGO_ALLOWED_HOSTS
NEXT_PUBLIC_API_URL
S3_ENDPOINT
S3_BUCKET
S3_ACCESS_KEY
S3_SECRET_KEY
EMAIL_HOST
EMAIL_PORT
EMAIL_USER
EMAIL_PASSWORD
PAYMENT_PROVIDER_KEYS
COURIER_PROVIDER_KEYS
```

## Docker networking

Use private Docker networks. Never expose PostgreSQL or Redis directly to the public internet.

```text
web ───────► api
api ───────► db
api ───────► redis
worker ────► redis
worker ────► db
beat ──────► redis
beat ──────► db
nginx ─────► web
nginx ─────► api
```

## Persistent storage

Development volumes may include `postgres_data`, `redis_data`, and `minio_data`. Production must use durable persistent storage. Never rely on an ephemeral container filesystem for business data or uploaded product images.

## Database migration strategy

Django migrations must be a controlled deployment step. Prefer: `Build → Deploy → Migration job → Application rollout`. Do not blindly run migrations in every application replica at startup.

## Static files and media

Separate static files from media/product images. Product media should use S3-compatible object storage or equivalent durable storage in production.

## Health checks

Provide liveness and readiness checks, for example `/api/health/` and `/api/ready/`. Do not expose sensitive diagnostic details.

## Docker security

Production containers must:

- Run as non-root where practical
- Use minimal base images
- Pin important dependencies
- Avoid unnecessary OS packages
- Never contain secrets
- Use read-only filesystems where practical
- Drop unnecessary Linux capabilities
- Be scanned for vulnerabilities
- Be regularly updated
- Use `.dockerignore`

## Docker image optimization

Use multi-stage builds, layer caching, dependency-only layers, minimal runtime images, and BuildKit cache where useful. Avoid invalidating dependency layers unnecessarily.

## Local developer workflow

Document actual project commands in the README. Initial examples:

```bash
docker compose up --build
docker compose up -d
docker compose logs -f
docker compose exec api python manage.py migrate
docker compose exec api python manage.py createsuperuser
docker compose exec api pytest
docker compose exec web npm test
docker compose exec web npm run test:e2e
```

Use the project's actual package manager and test commands.

## Test Docker environment

Create `docker-compose.test.yml`. CI must be able to start PostgreSQL, Redis, API, worker, and web services and run automated tests against the containerized environment.

## CI/CD Docker pipeline

```text
Checkout
   ↓
Lint
   ↓
Type check
   ↓
Unit tests
   ↓
Integration tests
   ↓
Build Docker images
   ↓
Container security scan
   ↓
E2E tests
   ↓
Push immutable images
   ↓
Deploy staging
   ↓
Smoke tests
   ↓
Production approval
   ↓
Deploy production
```

Do not use mutable `latest` as the only production reference. Use immutable tags such as `web:<git-sha>` and `api:<git-sha>`.

## Production deployment strategy

Support Development → Staging → Production with separate databases, secrets, storage, Redis where required, and environment configuration. Never point staging at production PostgreSQL.

## Deployment rollback

Document rollback for application images, configuration, and database migrations. Application rollback must use a previous immutable image. Use backward-compatible expand/contract migration patterns for risky schema changes.

## Production Docker architecture

```text
                         INTERNET
                            │
                            ▼
                    Load Balancer / CDN
                            │
                            ▼
                         Nginx
                            │
               ┌────────────┴────────────┐
               ▼                         ▼
          Next.js replicas          Django replicas
                                         │
                         ┌───────────────┼───────────────┐
                         ▼               ▼               ▼
                     PostgreSQL        Redis          Object Storage
                         │               │
                         │               ▼
                         │          Celery Workers
                         │               │
                         │          Celery Beat
                         │
                         ▼
                    Backup System
```

Start with the smallest reliable production architecture and scale components when actual load requires it.

## Docker Definition of Done

- [ ] Entire development environment runs through Docker Compose
- [ ] Backend runs in a container
- [ ] Frontend runs in a container
- [ ] PostgreSQL is containerized for local development
- [ ] Redis is containerized
- [ ] Celery worker is containerized
- [ ] Celery scheduler is containerized
- [ ] Reverse proxy configuration exists where required
- [ ] Production Dockerfiles use multi-stage builds
- [ ] Containers do not contain secrets
- [ ] Health checks exist
- [ ] Persistent data uses proper volumes/storage
- [ ] Migrations are a controlled deployment step
- [ ] CI builds Docker images
- [ ] Images are security scanned
- [ ] Images use immutable tags
- [ ] Staging deployment is documented
- [ ] Production deployment is documented
- [ ] Rollback procedure is documented
- [ ] Database backup/restore procedure is documented
- [ ] README contains complete Docker commands
- [ ] A new developer can start the system from a clean machine using Docker

---

# Dockerization Milestone

Dockerization is not a final afterthought. Establish the base Docker/Compose setup during the foundation phase, then harden production images and CI/CD during deployment.

The implementation sequence is:

```text
Repository
   ↓
Base Dockerfiles
   ↓
Docker Compose development
   ↓
API + Web + PostgreSQL + Redis
   ↓
Celery + background jobs
   ↓
Test Compose environment
   ↓
CI image builds
   ↓
Security scanning
   ↓
Staging containers
   ↓
Production containers
```


# 38. Phase 32 — Deployment

Create:

```text
Development
Staging
Production
```

Environment variables must be separated.

Dockerize:

```text
web
api
postgres
redis
worker
scheduler
```

Use CI/CD:

```text
Push
 ↓
Lint
 ↓
Type check
 ↓
Unit tests
 ↓
Integration tests
 ↓
Build
 ↓
Deploy staging
 ↓
Smoke tests
 ↓
Production approval
```

---

# 39. Phase 33 — Backup and Disaster Recovery

Implement:

- Automated PostgreSQL backups
- Backup retention
- Off-server backup
- Restore testing
- Media backup
- Disaster recovery documentation

A backup that has never been restored is not considered verified.

Document:

```text
How to restore database
How to restore media
How to redeploy
How to rotate secrets
How to recover from failed deployment
```

---

# 40. Phase 34 — Seed/Demo Data

Create realistic seed data:

```text
Categories
Products
Variants
Brands
Suppliers
Customers
Users
Branches
Sample purchases
Sample inventory
Sample orders
```

Include different product types:

- Clothing with size/color
- Shoes with size
- Cosmetics with shade/expiry
- Bags with color/capacity

This allows the agent to test the whole system.

---

# 41. Phase 35 — User Acceptance Testing

Create acceptance scenarios.

## Store owner

- Add product
- Purchase stock
- View inventory
- View sales
- View profit
- Manage employees

## Cashier

- Login
- Scan
- Sell
- Accept payment
- Print receipt
- Return item

## Customer

- Browse
- Search
- Filter
- Add to cart
- Checkout
- Pay
- Track order
- Return item
- Review product

---

# 42. Phase 36 — Production Readiness Checklist

Before launch, verify:

- [ ] Authentication works
- [ ] Roles work
- [ ] Permissions work
- [ ] Products work
- [ ] Variants work
- [ ] Barcode works
- [ ] Inventory ledger works
- [ ] Purchases work
- [ ] POS works
- [ ] Online store works
- [ ] Cart works
- [ ] Checkout works
- [ ] Payment works
- [ ] COD works if enabled
- [ ] Shipping works
- [ ] Returns work
- [ ] Refunds work
- [ ] Reports work
- [ ] Audit logs work
- [ ] Backups work
- [ ] Restore tested
- [ ] Security review complete
- [ ] E2E tests pass
- [ ] Production deployment tested
- [ ] Error monitoring enabled

---

# 43. Recommended MVP Scope

Do not attempt every feature immediately.

## MVP

Build these first:

```text
Authentication
Roles
Branches

Categories
Products
Variants
Images

Suppliers
Purchases

Inventory
Inventory ledger

POS
Barcode
Sales
Payments
Receipts

Customers

Online Store
Product pages
Search/filter
Cart
Checkout
COD
Online order management

Returns

Dashboard
Basic sales/inventory reports
```

## V1.1

```text
Online payment gateways
Shipping integrations
Coupons
Wishlist
Reviews
Advanced reports
Excel export
Notifications
```

## V2

```text
Offline POS
Multi-branch transfers
Loyalty
Advanced promotions
Courier API
Advanced customer segmentation
Advanced analytics
```

## V3

```text
Mobile app
AI recommendations
Demand forecasting
Automated purchasing suggestions
Advanced CRM
Marketplace integrations
Multi-tenant SaaS
```

---

# 44. Future AI Features

Do NOT build these before the transactional system is stable.

Potential future features:

### Demand forecasting

Predict:

```text
Which products will sell next month?
```

### Reorder recommendations

```text
Current stock: 8
Average weekly sales: 20
Lead time: 2 weeks

Recommended reorder: 40
```

### Product recommendations

```text
Customers who bought this also bought...
```

### Customer segmentation

```text
High value
Frequent buyer
Dormant
New customer
```

### Sales anomaly detection

```text
Unusually high discount
Unusual refund activity
Unusual cashier behavior
```

---

# 45. Important Business Rules to Document

Create a dedicated document:

```text
docs/architecture/business-rules.md
```

Define exactly:

- How stock is calculated
- When stock is reserved
- When stock is deducted
- How returns affect stock
- How damaged returns are handled
- How refunds work
- How discounts work
- How taxes work
- How profit is calculated
- How purchase cost is calculated
- How order cancellation works
- How COD orders work
- How payment failures work
- How expired reservations work

The AI agent must not invent these rules silently.

If a business rule is genuinely unspecified, mark it as:

```text
DECISION REQUIRED
```

and choose a sensible default only after documenting the assumption.

---

# 46. API Design

Use versioned APIs.

Example:

```text
/api/v1/auth/
/api/v1/products/
/api/v1/categories/
/api/v1/inventory/
/api/v1/purchases/
/api/v1/orders/
/api/v1/payments/
/api/v1/customers/
/api/v1/returns/
/api/v1/shipping/
/api/v1/reports/
```

Use consistent response/error formats.

Example error structure:

```json
{
  "error": {
    "code": "INSUFFICIENT_STOCK",
    "message": "The requested quantity is not available.",
    "details": {}
  }
}
```

Do not expose internal stack traces in production.

---

# 47. Database Rules

The agent must:

- Use migrations
- Add indexes intentionally
- Add unique constraints
- Use foreign keys
- Use decimal/numeric for money
- Never use floating-point numbers for monetary values
- Use timezone-aware timestamps
- Use UUIDs or a documented ID strategy
- Add created/updated timestamps where appropriate
- Preserve transaction history
- Use database transactions for critical operations

Money should use:

```text
Decimal / NUMERIC
```

not:

```text
float
```

---

# 48. UI/UX Rules

## Storefront

Prioritize:

1. Mobile responsiveness
2. Product photography
3. Fast navigation
4. Search
5. Filters
6. Clear pricing
7. Easy checkout
8. Trust
9. Accessibility

## Admin

Prioritize:

1. Data density
2. Tables
3. Filters
4. Bulk actions
5. Keyboard support
6. Clear statuses
7. Confirmation for destructive actions

## POS

Prioritize:

1. Speed
2. Barcode
3. Keyboard
4. Large touch targets
5. Minimal clicks
6. Reliable operation

---

# 49. Definition of Done for Every Feature

A feature is not complete until:

```text
[ ] Database changes complete
[ ] Backend business logic complete
[ ] API complete
[ ] Frontend complete
[ ] Validation complete
[ ] Authorization complete
[ ] Error states complete
[ ] Loading states complete
[ ] Empty states complete
[ ] Tests written
[ ] Tests passing
[ ] Documentation updated
[ ] Audit requirements considered
[ ] Accessibility considered
[ ] Security considered
```

---

# 50. AI Agent Operating Prompt

Use the following as the persistent instruction for the coding agent:

> You are the lead software architect and senior full-stack engineer responsible for building this retail and e-commerce platform end to end.
>
> Do not implement the whole system in one step.
>
> Work phase by phase according to `docs/architecture/roadmap.md`.
>
> Before modifying code:
>
> 1. Inspect the existing repository.
> 2. Read `CLAUDE.md`.
> 3. Read relevant architecture and business-rule documentation.
> 4. Determine dependencies and existing implementation.
> 5. Identify the smallest coherent implementation unit.
>
> For every implementation:
>
> - Preserve existing working functionality.
> - Follow the documented architecture.
> - Use PostgreSQL transactions for business-critical operations.
> - Treat inventory as a ledger-driven system.
> - Never trust client-provided prices, permissions, stock, discounts, or totals.
> - Enforce authorization on the backend.
> - Never silently delete transaction history.
> - Write tests for business-critical behavior.
> - Run linting, type checks, and relevant tests before declaring completion.
> - Update documentation when architecture or business behavior changes.
>
> Never invent unspecified business rules without documenting the assumption.
>
> If a requirement is ambiguous and could materially affect database design, inventory, payments, security, or order behavior, stop and mark it as `DECISION REQUIRED` rather than silently implementing a dangerous assumption.
>
> Prefer a modular monolith over premature microservices.
>
> Prefer simple, maintainable solutions over unnecessary complexity.
>
> Do not add a dependency unless there is a clear benefit.
>
> For every phase, provide:
>
> - What was implemented
> - Files changed
> - Database changes
> - API changes
> - Tests added
> - Tests executed
> - Known limitations
> - Next recommended task
>
> Do not claim a feature is complete unless it is actually implemented and tested.

---

# 51. Recommended Claude Code Skills

For this project, don't install dozens of unrelated skills. Use a focused set.

## Highest priority

### 1. Full-stack development

Useful for coordinating Next.js + API + database work.

A strong community option is Jeff Allan's **Fullstack Dev Skills**, which contains specialized full-stack development skills and a documented installation workflow. citeturn0search10turn0search5

### 2. Next.js

Use a dedicated Next.js skill for:

- App Router
- Server Components
- caching
- routing
- SEO
- server/client boundaries

### 3. React / TypeScript

Useful for frontend architecture, component patterns, state, typing, and maintainability.

### 4. PostgreSQL

Highly recommended because this application is database-heavy.

Focus on:

- indexing
- constraints
- transactions
- locking
- query optimization
- migrations

### 5. Django / Python

Use a backend-specific skill for:

- Django architecture
- DRF
- serializers
- permissions
- transactions
- services
- testing

### 6. Playwright

Essential for this project because the most important flows are end-to-end:

```text
POS → Sale → Inventory
Store → Checkout → Order
Order → Return → Refund
Purchase → Inventory
```

### 7. Security / OWASP

Very important because this application handles:

- customer data
- payments
- employee permissions
- inventory
- financial information

### 8. Docker

Useful for reproducible development and deployment.

### 9. GitHub Actions / CI/CD

Automate:

```text
lint
typecheck
test
build
security checks
deployment
```

### 10. UI/UX / accessibility

Useful specifically for:

- POS design
- responsive e-commerce
- admin tables
- accessibility
- keyboard workflows

---

# 52. Skill Marketplace Recommendations

A particularly relevant current option is **Agents Inc Skills**, which advertises 150+ atomic skills covering Next.js, React, PostgreSQL, React Query, Playwright, PWA/offline-first, Docker, GitHub Actions, security, Tauri, and more. citeturn0search1

Another strong option is **Jeff Allan's Claude Skills**, which focuses on full-stack development and currently documents 66 specialized skills. citeturn0search10

For engineering workflow specifically, **Addy Osmani's agent-skills** marketplace focuses on production-grade skills covering specification, planning, implementation, verification, review, and shipping. citeturn0search8

For a large standards-oriented collection, **Seth Ford's Claude Skills** includes dedicated architect, engineer, security, designer, QA, and SDLC roles. This is potentially useful later, but I would not install the entire collection for this project initially because it is much larger than necessary. citeturn0search11

A community marketplace such as **Token-Eater's Skills Marketplace** is another option, with development, testing, DevOps, security, web, and documentation categories. Treat community skills as optional and review them before installing. citeturn0search0

---

# 53. My Recommended Skill Set

For this particular project, I'd aim for:

```text
Architecture / Design
├── software architecture
├── database architecture
└── API design

Frontend
├── Next.js
├── React
├── TypeScript
├── Tailwind
├── shadcn/ui
├── React Query
└── PWA / Offline First

Backend
├── Python
├── Django
├── Django REST Framework
└── PostgreSQL

Testing
├── Playwright
├── unit testing
├── API testing
└── integration testing

Engineering
├── Git
├── code review
├── refactoring
├── Docker
└── CI/CD

Security
├── OWASP
├── authentication
└── authorization

Product/UI
├── e-commerce UX
├── POS UX
├── accessibility
└── responsive design
```

Do **not** install all available skills just because they exist. Skills are most useful when they add domain knowledge the agent would otherwise need repeatedly. Claude Code's current skill model is designed around loading specialized instructions when relevant rather than putting every procedure into the permanent project instructions. citeturn0search4

---

# 54. Suggested Project Documentation

At the beginning, create:

```text
docs/
├── roadmap.md
├── requirements.md
├── business-rules.md
│
├── architecture/
│   ├── architecture.md
│   ├── domain-model.md
│   ├── inventory.md
│   ├── orders.md
│   ├── payments.md
│   ├── offline-pos.md
│   └── decisions/
│
├── database/
│   ├── erd.md
│   ├── schema.md
│   └── indexing.md
│
├── api/
│   ├── conventions.md
│   └── endpoints.md
│
├── testing/
│   ├── strategy.md
│   └── acceptance-tests.md
│
└── operations/
    ├── deployment.md
    ├── backups.md
    └── disaster-recovery.md
```

This documentation is extremely important when using an AI coding agent because it becomes the project's persistent source of truth.

---


# Mandatory Frontend Design Skills for Claude

Claude Code MUST use the following skills whenever it designs, implements, reviews, or significantly modifies any frontend UI for this project:

```text
/ui-ux-pro-max
/frontend-animation
```

## `/ui-ux-pro-max` — mandatory

Use `/ui-ux-pro-max` for the frontend design system and UX decisions, including:

- Visual hierarchy
- Layout and composition
- E-commerce UX
- POS UX
- Admin dashboard UX
- Responsive design
- Typography
- Color usage
- Spacing
- Component design
- Product cards
- Navigation
- Forms
- Tables
- Checkout UX
- Accessibility
- Mobile UX
- Design consistency

The agent must consult and follow this skill **before creating a new major frontend page, design system component, or frontend visual pattern**.

The Rangon Fashion brand guidelines in this document remain the source of truth for brand-specific colors, typography, logo usage, and visual identity. The skill must complement those guidelines rather than override them.

## `/frontend-animation` — mandatory

Use `/frontend-animation` whenever implementing or modifying frontend motion, transitions, micro-interactions, page transitions, hover effects, scroll interactions, animated navigation, modals, drawers, product interactions, loading states, or other UI animation.

Animations must be:

- Purposeful
- Smooth
- Performant
- Accessible
- Consistent with the Rangon Fashion brand
- Responsive across devices
- Respectful of `prefers-reduced-motion`

Do not add decorative animation merely for visual novelty. Motion must improve feedback, hierarchy, orientation, or perceived performance.

## Mandatory Claude frontend workflow

For every significant frontend feature, Claude must follow this sequence:

```text
Requirement
    ↓
Read CLAUDE.md + relevant architecture docs
    ↓
Use /ui-ux-pro-max for UX/UI direction
    ↓
Use Rangon Fashion design system
    ↓
Implement frontend structure
    ↓
Use /frontend-animation for motion/interactions where applicable
    ↓
Implement responsive behavior
    ↓
Check accessibility + reduced motion
    ↓
Run frontend tests / type checks / lint
    ↓
Review against design system
```

### Prohibited frontend behavior

Claude must NOT:

- Invent a separate visual language for individual pages
- Introduce random colors outside the documented palette without justification
- Use excessive gradients, glassmorphism, or decorative effects that conflict with the brand
- Add animations that negatively affect POS speed or usability
- Use motion that cannot be disabled/reduced for users who prefer reduced motion
- Copy a generic SaaS dashboard aesthetic onto the fashion storefront
- Create inconsistent buttons, cards, forms, spacing, or typography when an existing design-system component exists

The frontend should feel like **one coherent Rangon Fashion product**, even though it contains a public storefront, POS, and administration interface.

# 55. Final Implementation Order

The AI agent should follow this order:

```text
01. Project Constitution
        ↓
02. Architecture
        ↓
03. Database
        ↓
04. Auth + RBAC
        ↓
05. Product Catalog
        ↓
06. Inventory Engine
        ↓
07. Suppliers + Purchasing
        ↓
08. POS
        ↓
09. Payments
        ↓
10. Returns
        ↓
11. Customers
        ↓
12. Online Store
        ↓
13. Search + Filters
        ↓
14. Cart
        ↓
15. Checkout
        ↓
16. Online Payments
        ↓
17. Orders
        ↓
18. Shipping
        ↓
19. Coupons
        ↓
20. Wishlist + Reviews
        ↓
21. Dashboard
        ↓
22. Reports
        ↓
23. Offline POS
        ↓
24. Barcode + Printing
        ↓
25. Notifications
        ↓
26. SEO
        ↓
27. Security Audit
        ↓
28. Performance
        ↓
29. E2E Testing
        ↓
30. Deployment
        ↓
31. Backup/Recovery
        ↓
32. Production Launch
```

**Do not reverse this order casually.** In particular, don't build the beautiful online storefront before the product/variant/inventory/order architecture is stable.

---

# 56. Long-Term Architecture

The end goal is:

```text
                         RETAIL PLATFORM
                               │
             ┌─────────────────┼─────────────────┐
             │                 │                 │
             ▼                 ▼                 ▼
        ONLINE STORE         POS             ADMIN
             │                 │                 │
             └─────────────────┼─────────────────┘
                               │
                         UNIFIED API
                               │
              ┌────────────────┼────────────────┐
              │                │                │
              ▼                ▼                ▼
          PRODUCTS         INVENTORY         ORDERS
              │                │                │
              └────────────────┼────────────────┘
                               │
                         POSTGRESQL
                               │
             ┌─────────────────┼─────────────────┐
             ▼                 ▼                 ▼
         PAYMENTS          SHIPPING          ANALYTICS
```

The most important thing is **not the UI framework**. The most important parts are the **inventory ledger, product/variant model, order lifecycle, payment model, permissions, and transactional consistency**. If those are designed correctly, the POS, website, mobile app, and future branches can all be built on top of the same foundation.

---

# 57. RANGON FASHION — Brand Identity and Design System

The uploaded logo is the authoritative brand reference for the application.

The logo establishes three dominant visual signals:

1. **Near-black / black** background and premium contrast
2. **Vivid orange-red** as the signature brand accent
3. **White** typography for strong contrast and a modern fashion identity

The software must use the logo as a brand asset rather than attempting to recreate the logo with HTML text or a generic icon.

## 57.1 Brand personality

The visual system should communicate:

- Modern
- Premium but accessible
- Fashion-forward
- Bold
- Clean
- Confident
- Fast
- Contemporary

Avoid:

- Excessive gradients
- Childish colors
- Overly rounded "app" styling
- Heavy glassmorphism
- Excessive shadows
- Decorative UI that reduces usability
- Generic blue SaaS styling

The brand should feel like a **fashion retailer first and a software product second**.

---

## 57.2 Logo usage

Use the supplied logo asset as the primary logo.

Required logo variants should be prepared if they do not already exist:

```text
Rangon Fashion — Full Logo — Dark Background
Rangon Fashion — Full Logo — Light Background
Rangon Symbol — Standalone
Rangon Wordmark — Optional
```

### Primary usage

The uploaded logo is optimized for a dark background and should be the default version for:

- Website header where appropriate
- POS splash/login screen
- Admin login screen
- Email header where appropriate
- Invoice/receipt branding where space allows
- Favicon/app icon derived from the symbol

### Clear space

Maintain clear space around the logo. Do not place text, buttons, borders, or other UI elements directly against the logo.

Recommended minimum clear space:

```text
0.25 × logo symbol height
```

### Do not

- Stretch the logo
- Compress the logo
- Rotate the logo
- Change the red to arbitrary colors
- Add drop shadows directly to the logo
- Add gradients to the logo
- Place it on visually noisy backgrounds
- Recreate the wordmark using a normal font

---

# 58. Brand Color System

The uploaded logo was inspected visually and the dominant red/orange is approximately in the range of **#FB3208**. Treat this as the initial digital brand reference and allow the final production asset to remain the source of truth if the original vector/brand color specification becomes available.

## 58.1 Core brand palette

| Token | Hex | Usage |
|---|---|---|
| `brand-500` | `#FB3208` | Primary Rangon red/orange |
| `brand-600` | `#E52B05` | Hover/pressed primary |
| `brand-700` | `#C92304` | Strong active state |
| `brand-400` | `#FF5530` | Highlight/light accent |
| `brand-100` | `#FFE6E0` | Soft brand background |
| `brand-50` | `#FFF4F1` | Very subtle brand tint |
| `black` | `#000000` | Logo/dark brand foundation |
| `white` | `#FFFFFF` | Logo/light text |

The brand red should be used intentionally. It is an accent, not a background color for large areas by default.

### Primary rule

Use:

```text
Black / White → structure and hierarchy
Brand Red     → action, emphasis, identity
Neutral Gray  → supporting information
```

Do not make every UI element red.

---

## 58.2 Neutral palette

Use neutral tones rather than introducing unrelated colors.

```text
neutral-950  #0A0A0A
neutral-900  #111111
neutral-800  #1C1C1C
neutral-700  #2B2B2B
neutral-600  #525252
neutral-500  #737373
neutral-400  #A3A3A3
neutral-300  #D4D4D4
neutral-200  #E5E5E5
neutral-100  #F5F5F5
neutral-50   #FAFAFA
white        #FFFFFF
```

For the storefront, prefer a warm/neutral white such as `#FAFAFA` for large page surfaces instead of making every section pure white.

---

## 58.3 Semantic colors

Brand red is **not** the generic error color. Use separate semantic colors so users can distinguish business states from the brand identity.

| Semantic | Color | Example |
|---|---|---|
| Success | `#16A34A` | Paid, delivered, completed |
| Warning | `#D97706` | Low stock, pending |
| Error | `#DC2626` | Failed payment, validation error |
| Info | `#2563EB` | Informational state |
| Neutral | `#737373` | Draft, archived |

These colors should primarily appear in badges, icons, alerts, charts, and status indicators rather than large decorative areas.

---

# 59. Color Tokens for Light and Dark Interfaces

The platform has three distinct surfaces:

```text
1. Public Storefront
2. Admin Dashboard
3. POS
```

They should share the same design language but can use different surface treatments.

## 59.1 Storefront

Default:

```text
Background: #FAFAFA
Surface:     #FFFFFF
Text:        #111111
Muted:       #737373
Border:      #E5E5E5
Primary:     #FB3208
```

Use generous whitespace and high-quality product photography.

## 59.2 Admin

Recommended default: light theme with an optional dark theme later.

```text
App background: #F5F5F5
Cards:          #FFFFFF
Text:           #171717
Muted:          #737373
Borders:        #E5E5E5
Primary:        #FB3208
```

Admin interfaces should optimize for data density and long work sessions.

## 59.3 POS

Use a high-contrast interface designed for speed.

Recommended:

```text
Background: #F5F5F5
Main surface: #FFFFFF
Primary action: #FB3208
Text: #111111
```

Provide a dark POS mode only if testing shows it improves the store's workflow.

---

# 60. Typography System

The logo itself uses a custom/brand wordmark. **Do not try to reproduce the logo typography using the UI font.**

For the digital product, use a modern geometric display face paired with a highly readable UI font.

## Recommended fonts

### Primary UI font

**Inter**

Use for:

- Body text
- Forms
- Tables
- Buttons
- Navigation
- POS
- Admin
- Product metadata

### Display font

**Space Grotesk**

Use selectively for:

- Major storefront headings
- Hero headlines
- Marketing sections
- Campaign titles
- Large dashboard KPI numbers where appropriate

Do not use Space Grotesk for dense tables or long paragraphs.

## Font stack

```css
--font-sans: "Inter", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
--font-display: "Space Grotesk", "Inter", system-ui, sans-serif;
```

If the final brand team supplies a proprietary typeface, replace the display font without changing the rest of the design system.

---

# 61. Typography Scale

Use a restrained scale.

| Token | Size | Line Height | Weight | Usage |
|---|---:|---:|---:|---|
| `display-xl` | 56px | 1.05 | 700 | Major storefront hero |
| `display-lg` | 44px | 1.10 | 700 | Large campaign heading |
| `h1` | 36px | 1.15 | 700 | Page heading |
| `h2` | 30px | 1.20 | 700 | Section heading |
| `h3` | 24px | 1.25 | 650 | Subsection |
| `h4` | 20px | 1.30 | 600 | Card heading |
| `body-lg` | 18px | 1.55 | 400 | Intro/lead text |
| `body` | 16px | 1.50 | 400 | Default text |
| `body-sm` | 14px | 1.45 | 400 | Secondary text |
| `caption` | 12px | 1.40 | 500 | Metadata |

On mobile, reduce display sizes responsively rather than allowing large headings to dominate the viewport.

---

# 62. Typography Rules

Use weight for hierarchy instead of many colors.

Preferred weights:

```text
400 → body
500 → labels/navigation
600 → buttons/subheadings
700 → headings
```

Avoid using 800/900 throughout the application.

### Prices

Product prices should be visually prominent.

Example:

```text
৳ 1,290
```

Use tabular numerals for financial tables and POS totals where possible.

### Currency

The system should support BDT by default:

```text
৳ 1,290
```

But currency formatting must be configurable rather than hard-coded into business logic.

---

# 63. Spacing System

Use a 4px base grid.

```text
4px   0.25rem
8px   0.5rem
12px  0.75rem
16px  1rem
20px  1.25rem
24px  1.5rem
32px  2rem
40px  2.5rem
48px  3rem
64px  4rem
80px  5rem
96px  6rem
```

Default component spacing should usually be based on 8px increments.

Avoid arbitrary values unless a design requirement requires them.

---

# 64. Border Radius

Rangon should feel modern and premium, not overly playful.

Recommended:

```text
radius-sm   = 6px
radius-md   = 8px
radius-lg   = 12px
radius-xl   = 16px
radius-2xl  = 20px
radius-full = 9999px
```

Use:

- `radius-md` for forms and buttons
- `radius-lg` for cards
- `radius-xl` for major storefront modules
- `radius-full` for pills and avatars

Avoid excessive rounded cards everywhere.

---

# 65. Shadows

Use shadows sparingly.

```css
--shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.05);
--shadow-md: 0 4px 12px rgba(0, 0, 0, 0.08);
--shadow-lg: 0 12px 30px rgba(0, 0, 0, 0.10);
```

The storefront should primarily rely on spacing, borders, typography, and photography rather than heavy shadows.

Admin cards should usually use subtle borders rather than large floating shadows.

---

# 66. Buttons

## Primary

```text
Background: brand-500
Text: white
Hover: brand-600
Active: brand-700
```

Use for:

- Add to cart
- Checkout
- Complete sale
- Save
- Confirm

## Secondary

```text
Background: white
Border: neutral-300
Text: neutral-900
Hover: neutral-100
```

## Ghost

```text
Background: transparent
Text: neutral-700
Hover: neutral-100
```

## Destructive

Use semantic error red, not brand red.

```text
Background: #DC2626
Text: white
```

Examples:

- Delete
- Cancel irreversible operation
- Void where appropriate

---

# 67. Inputs and Forms

Inputs should be clean and highly readable.

```text
Height: 40–44px desktop
Height: 44–48px touch interfaces
Border: #D4D4D4
Radius: 8px
Focus ring: brand red
```

Focus state:

```text
border: brand-500
ring: rgba(251, 50, 8, 0.18)
```

Never rely on color alone to communicate errors.

Show:

```text
Field label
Input
Error message
```

Example:

```text
Phone Number
[ 01XXXXXXXXX       ]
Please enter a valid phone number.
```

---

# 68. Cards

Cards should be simple and structured.

### Storefront product card

```text
Image
Badge (optional)
Brand/category (optional)
Product name
Rating (optional)
Price
Compare-at price (optional)
Color/variant indicators
```

Avoid putting every possible piece of metadata on the card.

### Admin card

```text
Title
Value
Context/change
Optional icon
```

---

# 69. Product Photography Rules

Fashion e-commerce should prioritize photography.

Product images should:

- Use consistent aspect ratios
- Have sufficient resolution
- Support zoom where useful
- Use descriptive alt text
- Load responsively
- Use optimized formats
- Have consistent visual treatment

Recommended product image ratio:

```text
4:5
```

Use `object-fit: cover` only when cropping does not remove important product details.

For shoes/cosmetics/bags, support category-specific image ratios if needed, but keep the storefront grid visually consistent.

---

# 70. Storefront Visual Direction

The storefront should feel like a fashion brand website, not an admin dashboard.

## Header

Recommended structure:

```text
[LOGO]   Men   Women   Kids   Shoes   Bags   Cosmetics   [Search] [Account] [Cart]
```

Keep navigation concise.

On mobile:

```text
[Menu] [Logo] [Search] [Cart]
```

## Hero

Use large photography with concise copy.

Avoid huge paragraphs.

Example hierarchy:

```text
NEW SEASON
Elevate Your Everyday
[ SHOP NOW ]
```

The CTA should use the Rangon brand red.

---

# 71. Storefront Product Detail Page

Recommended layout:

```text
┌───────────────────────────────┬─────────────────────────┐
│                               │ Product name            │
│                               │ Rating                  │
│       PRODUCT GALLERY         │ Price                   │
│                               │ Color                   │
│                               │ Size                    │
│                               │ Quantity                │
│                               │ [ ADD TO CART ]         │
│                               │ [ BUY NOW ]             │
│                               │                         │
└───────────────────────────────┴─────────────────────────┘

Description
Specifications
Shipping / Returns
Reviews
Related products
```

Use sticky purchase controls on mobile only if usability testing supports it.

---

# 72. Admin Visual Direction

The admin interface should be functional and restrained.

Recommended layout:

```text
┌─────────────┬──────────────────────────────────────────┐
│             │ Topbar                                   │
│   Sidebar   ├──────────────────────────────────────────┤
│             │                                          │
│ Dashboard   │ Page heading                             │
│ Sales       │ Filters                                  │
│ Products    │                                          │
│ Inventory   │ Main content                             │
│ Orders      │                                          │
│ Reports     │                                          │
│ Settings    │                                          │
└─────────────┴──────────────────────────────────────────┘
```

Sidebar should use brand red for active navigation, but not fill the entire sidebar with red.

---

# 73. POS Visual Direction

The POS is operational software and must prioritize speed over visual decoration.

Recommended layout:

```text
┌─────────────────────────────────────────────────────────┐
│ Rangon Fashion          Register 01       Cashier       │
├───────────────────────────────┬─────────────────────────┤
│                               │ CART                    │
│ SEARCH / BARCODE              │                         │
│                               │ Product                 │
│ Categories                    │ Product                 │
│                               │                         │
│ Product grid/list             │ ----------------------- │
│                               │ TOTAL                   │
│                               │                         │
│                               │ [ CASH ] [ CARD ]       │
└───────────────────────────────┴─────────────────────────┘
```

POS requirements:

- Keyboard-first
- Barcode-first
- Large totals
- Clear cart state
- Clear payment state
- Minimal animation
- Minimal navigation
- High contrast

---

# 74. Status Badge System

Use consistent status badges across admin and order management.

Examples:

```text
Paid       → Success
Pending    → Warning
Failed     → Error
Processing → Info
Cancelled  → Neutral/Error
Delivered  → Success
Returned   → Neutral
```

Badges should include text, not color alone.

---

# 75. Icons

Use a single icon library consistently, preferably **Lucide** through the chosen UI component system.

Rules:

- Do not mix multiple icon families unnecessarily.
- Use icons to reinforce meaning, not replace labels in critical workflows.
- Use 16–20px icons for admin controls.
- Use 20–24px icons for primary POS controls.
- Maintain consistent stroke weight.

---

# 76. Motion and Animation

Motion should be subtle.

Use animation for:

- Cart updates
- Drawer/modal transitions
- Toast notifications
- Image/gallery transitions
- Page-level micro-interactions

Avoid:

- Excessive parallax
- Large animated backgrounds
- Long transitions
- Animation on every hover
- Motion that slows POS operations

Recommended duration:

```text
fast:   120–160ms
normal: 180–240ms
slow:   300–400ms
```

Respect `prefers-reduced-motion`.

---

# 77. Accessibility

Target **WCAG 2.2 AA** where practical.

Minimum requirements:

- Keyboard navigation
- Visible focus states
- Semantic HTML
- Proper labels
- Accessible dialogs
- Accessible menus
- Screen-reader-friendly buttons
- Sufficient contrast
- Error messages associated with fields
- No information conveyed by color alone
- Reduced-motion support

The POS should support keyboard workflows even when a mouse is available.

---

# 78. Responsive Breakpoints

Use Tailwind defaults unless project testing shows a reason to change them.

Recommended conceptual breakpoints:

```text
Mobile:  < 640px
Tablet:  640–1023px
Desktop: 1024–1279px
Large:   1280px+
```

Storefront must be designed mobile-first.

Admin can prioritize desktop but must remain usable on tablets.

POS should target desktop/tablet displays used at the counter.

---

# 79. Design Tokens Implementation

Create a centralized token layer.

Recommended CSS variables:

```css
:root {
  --brand-50: #FFF4F1;
  --brand-100: #FFE6E0;
  --brand-400: #FF5530;
  --brand-500: #FB3208;
  --brand-600: #E52B05;
  --brand-700: #C92304;

  --background: #FAFAFA;
  --foreground: #111111;
  --surface: #FFFFFF;
  --muted: #737373;
  --border: #E5E5E5;

  --success: #16A34A;
  --warning: #D97706;
  --error: #DC2626;
  --info: #2563EB;

  --radius-sm: 6px;
  --radius-md: 8px;
  --radius-lg: 12px;
  --radius-xl: 16px;

  --font-sans: "Inter", system-ui, sans-serif;
  --font-display: "Space Grotesk", "Inter", system-ui, sans-serif;
}
```

Do not scatter raw hex values throughout components.

If a color is needed repeatedly, create a token.

---

# 80. Tailwind / shadcn/ui Guidance

Use the Rangon design tokens as the source for the Tailwind/shadcn theme.

Do not accept the default shadcn neutral/primary colors unchanged.

The UI component library is a foundation, not the final brand identity.

Customize:

- Primary
- Accent
- Background
- Foreground
- Border
- Ring
- Destructive
- Muted
- Card
- Popover

The final interface should look unmistakably like Rangon Fashion rather than a default component-library demo.

---

# 81. Design System Component Inventory

Build reusable components rather than styling each page independently.

## Foundation

```text
Button
IconButton
Input
Textarea
Select
Combobox
Checkbox
Radio
Switch
Badge
Tooltip
Separator
Avatar
```

## Layout

```text
Container
Stack
Grid
Section
PageHeader
Sidebar
Topbar
MobileNav
```

## Data

```text
DataTable
Pagination
FilterBar
SearchInput
StatCard
ChartCard
EmptyState
Skeleton
```

## Commerce

```text
ProductCard
ProductGallery
PriceDisplay
VariantSelector
QuantitySelector
CartItem
CartSummary
CouponInput
CheckoutStep
OrderStatus
```

## POS

```text
POSProductSearch
BarcodeInput
POSCart
PaymentSelector
HeldOrderList
ReceiptPreview
```

## Feedback

```text
Toast
Alert
ConfirmDialog
ErrorState
LoadingState
```

---

# 82. Brand-Specific UI Rules for AI Agents

When generating UI, the AI agent must follow these rules:

1. Use the Rangon brand red `#FB3208` as the primary action color.
2. Do not introduce generic blue as the primary CTA color.
3. Use black/white/neutral colors for structure.
4. Keep the brand red concentrated on important actions and active states.
5. Use Inter for UI/body and Space Grotesk for selected display headings.
6. Use generous whitespace in the storefront.
7. Use compact, information-dense layouts in admin.
8. Use high-contrast, fast interactions in POS.
9. Keep product imagery visually dominant on the storefront.
10. Do not use excessive gradients or glassmorphism.
11. Do not use excessive rounded cards.
12. Do not use emoji as UI icons.
13. Use Lucide or the project's approved icon library.
14. Keep accessibility requirements intact when implementing visual designs.
15. Never recreate or modify the supplied logo with a text approximation.

---

# 83. Brand Asset Structure

Store brand assets in a predictable location.

```text
apps/web/public/brand/
├── logo/
│   ├── rangon-fashion-dark.svg
│   ├── rangon-fashion-light.svg
│   ├── rangon-symbol.svg
│   └── rangon-wordmark.svg
│
├── favicon/
│   ├── favicon.ico
│   ├── icon-192.png
│   └── icon-512.png
│
└── social/
    └── og-image.png
```

If SVG source is unavailable, use the supplied raster logo initially and replace it with an official vector asset when available.

Do not redraw the logo manually.

---

# 84. Design QA Checklist

Every major UI feature should be reviewed against:

```text
[ ] Rangon brand colors used correctly
[ ] Logo used correctly
[ ] Typography follows system
[ ] Spacing follows 4px grid
[ ] Button hierarchy is clear
[ ] Focus states visible
[ ] Contrast acceptable
[ ] Mobile layout tested
[ ] Desktop layout tested
[ ] Empty state designed
[ ] Loading state designed
[ ] Error state designed
[ ] Long text tested
[ ] Large numbers tested
[ ] Bengali/Unicode text tested where applicable
[ ] Accessibility reviewed
[ ] No default-library styling accidentally exposed
```

---

# 85. Design Phase Addition to the Development Roadmap

The original development roadmap should be expanded so the visual system is established before production UI work.

```text
00. Project Constitution
        ↓
01. Brand + Design System
        ↓
02. Architecture
        ↓
03. Database
        ↓
04. Auth + RBAC
        ↓
05. Product Catalog
        ↓
06. Inventory Engine
        ↓
07. Suppliers + Purchasing
        ↓
08. POS
        ↓
09. Payments
        ↓
10. Returns
        ↓
11. Customers
        ↓
12. Online Store
        ↓
13. Search + Filters
        ↓
14. Cart
        ↓
15. Checkout
        ↓
16. Online Payments
        ↓
17. Orders
        ↓
18. Shipping
        ↓
19. Coupons
        ↓
20. Wishlist + Reviews
        ↓
21. Dashboard
        ↓
22. Reports
        ↓
23. Offline POS
        ↓
24. Barcode + Printing
        ↓
25. Notifications
        ↓
26. SEO
        ↓
27. Security Audit
        ↓
28. Performance
        ↓
29. E2E Testing
        ↓
30. Deployment
        ↓
31. Backup/Recovery
        ↓
32. Production Launch
```

The **Brand + Design System** phase must produce:

```text
[ ] Color tokens
[ ] Typography tokens
[ ] Spacing tokens
[ ] Radius tokens
[ ] Shadow tokens
[ ] Button variants
[ ] Form styles
[ ] Card styles
[ ] Status badges
[ ] Navigation styles
[ ] Product card
[ ] Basic POS components
[ ] Admin shell
[ ] Storefront shell
[ ] Logo assets
[ ] Favicon/app icon
```

Do not start building dozens of pages until these primitives are established.

---

# 86. Final Brand Direction

The Rangon Fashion application should visually balance:

```text
                RANGON FASHION
                      │
        ┌─────────────┼─────────────┐
        │             │             │
        ▼             ▼             ▼
      BOLD          CLEAN         PREMIUM
        │             │             │
        └─────────────┼─────────────┘
                      │
                 BRAND RED
                      │
             #FB3208 / #E52B05
```

The overall design should feel **bold and fashionable without becoming visually loud**.

The black + white + Rangon red combination should remain the recognizable visual signature across the storefront, POS, admin dashboard, invoices, and future mobile/desktop applications.
