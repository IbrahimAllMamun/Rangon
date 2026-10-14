/**
 * The permission catalogue and the role matrix: what `sync-permissions`
 * writes to `accounts_permission`, `accounts_role` and the grants between
 * them (cli/sync-permissions.ts).
 *
 * Copied from Django's `accounts/permissions.py` and, since Django went
 * (removal plan, step 8), the only place a code is added or a grant changed.
 * docs/architecture/permissions.md is the account of it.
 */

/** code -> [group, the name a person reads]. In Django's order. */
export const PERMISSIONS: Readonly<Record<string, readonly [group: string, name: string]>> = {
  'products.view': ['products', 'View products'],
  'products.create': ['products', 'Create products'],
  'products.update': ['products', 'Update products'],
  'products.delete': ['products', 'Delete products'],
  'inventory.view': ['inventory', 'View inventory'],
  'inventory.adjust': ['inventory', 'Adjust stock'],
  'inventory.transfer': ['inventory', 'Transfer stock between branches'],
  'inventory.count': ['inventory', 'Perform stock counts'],
  'sales.view': ['sales', 'View sales'],
  'sales.create': ['sales', 'Create sales'],
  'sales.discount': ['sales', 'Apply discounts'],
  'sales.discount_override': ['sales', 'Approve large discounts'],
  'sales.cancel': ['sales', 'Cancel or void a sale'],
  'sales.refund': ['sales', 'Refund a sale'],
  'sales.refund_override': ['sales', 'Refund outside the return window'],
  'sales.payment_record': ['sales', 'Record a payment'],
  'orders.view': ['orders', 'View orders'],
  'orders.update_status': ['orders', 'Change order status'],
  'orders.fulfil': ['orders', 'Pack and ship orders'],
  'purchases.view': ['purchases', 'View purchases'],
  'purchases.create': ['purchases', 'Create purchase orders'],
  'purchases.receive': ['purchases', 'Receive stock'],
  'purchases.pay': ['purchases', 'Pay suppliers'],
  'finance.view': ['finance', 'View accounts and the cash book'],
  'finance.manage': ['finance', 'Open and edit accounts'],
  'finance.transfer': ['finance', 'Move money between accounts'],
  'finance.adjust': ['finance', 'Record a manual cash-book entry'],
  'finance.expense': ['finance', 'Record and void expenses'],
  'customers.view': ['customers', 'View customers'],
  'customers.create': ['customers', 'Create customers'],
  'customers.update': ['customers', 'Update customers'],
  'reports.view': ['reports', 'View reports'],
  'reports.financial': ['reports', 'View financial reports'],
  'reports.export': ['reports', 'Export reports'],
  'users.view': ['users', 'View users'],
  'users.manage': ['users', 'Create and edit users'],
  'settings.view': ['settings', 'View settings'],
  'settings.manage': ['settings', 'Change settings'],
  'content.review_moderate': ['content', 'Moderate reviews'],
  'content.coupons_manage': ['content', 'Manage coupons'],
  'content.navigation_manage': ['content', 'Manage navigation, banners and the homepage carousel'],
  'content.site_manage': ['content', 'Manage the footer, social links and site pages'],
  'audit.view': ['audit', 'View the audit log'],
};

/** `RoleCode`: every role, with the name it is shown by. All are system roles. */
export const ROLES: readonly (readonly [code: string, name: string])[] = [
  ['OWNER', 'Owner'],
  ['ADMIN', 'Administrator'],
  ['MANAGER', 'Manager'],
  ['CASHIER', 'Cashier'],
  ['INVENTORY_MANAGER', 'Inventory manager'],
  ['ACCOUNTANT', 'Accountant'],
  ['CUSTOMER', 'Customer'],
];

/** The one role that is not staff: `is_staff_role` is false for it alone. */
export const CUSTOMER_ROLE = 'CUSTOMER';

/**
 * What each role may do. OWNER is not here: it holds every permission
 * implicitly, and `sync-permissions` grants it every row as well, so that the
 * roles screen says what the role can do. ADMIN is every code, by decision
 * pending (business rule 7.1, D221).
 */
export const ROLE_PERMISSIONS: Readonly<Record<string, readonly string[]>> = {
  ADMIN: Object.keys(PERMISSIONS),
  MANAGER: [
    'products.view',
    'products.create',
    'products.update',
    'inventory.view',
    'inventory.adjust',
    'inventory.transfer',
    'inventory.count',
    'sales.view',
    'sales.create',
    'sales.discount',
    'sales.discount_override',
    'sales.cancel',
    'sales.refund',
    'sales.payment_record',
    'orders.view',
    'orders.update_status',
    'orders.fulfil',
    'purchases.view',
    'purchases.create',
    'purchases.receive',
    'finance.view',
    'finance.transfer',
    'finance.adjust',
    'finance.expense',
    'customers.view',
    'customers.create',
    'customers.update',
    'reports.view',
    'reports.financial',
    'reports.export',
    'users.view',
    'settings.view',
    'content.review_moderate',
    'content.coupons_manage',
    'content.navigation_manage',
    'content.site_manage',
  ],
  CASHIER: [
    'products.view',
    'inventory.view',
    'sales.view',
    'sales.create',
    'sales.discount',
    'sales.payment_record',
    'finance.view',
    'orders.view',
    'customers.view',
    'customers.create',
    'customers.update',
  ],
  INVENTORY_MANAGER: [
    'products.view',
    'products.create',
    'products.update',
    'inventory.view',
    'inventory.adjust',
    'inventory.transfer',
    'inventory.count',
    'orders.view',
    'orders.update_status',
    'orders.fulfil',
    'purchases.view',
    'purchases.create',
    'purchases.receive',
    'reports.view',
    'reports.export',
  ],
  ACCOUNTANT: [
    'products.view',
    'inventory.view',
    'sales.view',
    'sales.payment_record',
    'orders.view',
    'purchases.view',
    'purchases.pay',
    'finance.view',
    'finance.manage',
    'finance.transfer',
    'finance.adjust',
    'finance.expense',
    'customers.view',
    'reports.view',
    'reports.financial',
    'reports.export',
    'settings.view',
    'audit.view',
  ],
  CUSTOMER: [],
};
