import { bootstrapStore } from './cli/bootstrap-store';
import { createOwner } from './cli/create-owner';
import { migrate, Refusal } from './cli/migrate';
import { type Flags, parseFlags } from './cli/session';
import { syncPermissions } from './cli/sync-permissions';
import { verifyAccounts, verifyInventory } from './cli/verify';

/**
 * The operator's commands: `node dist/cli.js <command>`.
 *
 * What `python manage.py ...` is for Django, for the things an operator does
 * to a database rather than through the API
 * (docs/architecture/django-removal-plan.md, steps 3 and 4). Each command
 * connects, does one thing and exits: 0 when it is done, 1 when it refused or
 * failed, 2 when it was not understood. None runs as the API starts.
 */
type Run = (databaseUrl: string, log: (line: string) => void, flags: Flags) => Promise<void>;

const COMMANDS: Record<string, { summary: string; flags: readonly string[]; run: Run }> = {
  migrate: {
    summary: "bring the schema to this build's; adopts a database Django built",
    flags: [],
    run: migrate,
  },
  'sync-permissions': {
    summary: 'make the permissions, the roles and their grants what the catalogue says',
    flags: [],
    run: syncPermissions,
  },
  'create-owner': {
    summary: 'the first account of a shop: --email, and OWNER_PASSWORD in the environment',
    flags: ['email', 'first-name', 'last-name'],
    run: createOwner,
  },
  'bootstrap-store': {
    summary:
      'the organisation, first branch and cash drawer: --shop-name --branch-name --branch-code',
    flags: ['shop-name', 'branch-name', 'branch-code'],
    run: bootstrapStore,
  },
  'verify-inventory': {
    summary: 'the stock ledger against the cached stock: [--branch CODE] [--fix --reason "..."]',
    flags: ['branch', 'fix', 'reason'],
    run: verifyInventory,
  },
  'verify-accounts': {
    summary:
      'the cash book against the cached balances: [--branch CODE] [--fix --reason "..."] [--skip-unposted]',
    flags: ['branch', 'fix', 'reason', 'skip-unposted'],
    run: verifyAccounts,
  },
};

function usage(): string {
  const width = Math.max(...Object.keys(COMMANDS).map((name) => name.length));
  return [
    'usage: node dist/cli.js <command>',
    '',
    ...Object.entries(COMMANDS).map(
      ([name, command]) => `  ${name.padEnd(width)}  ${command.summary}`,
    ),
    '',
    'Reads DATABASE_URL, as the API does.',
  ].join('\n');
}

async function main(): Promise<number> {
  const [name, ...rest] = process.argv.slice(2);
  const command = name ? COMMANDS[name] : undefined;
  if (!command) {
    console.error(usage());
    return 2;
  }
  let flags: Flags;
  try {
    flags = parseFlags(rest, command.flags);
  } catch (error) {
    console.error(`${name}: ${(error as Error).message}\n\n${usage()}`);
    return 2;
  }
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL is not set.');
    return 2;
  }
  try {
    await command.run(databaseUrl, (line) => console.log(line), flags);
    return 0;
  } catch (error) {
    // A refusal is an answer; anything else is a fault, and wants its stack.
    console.error(error instanceof Refusal ? `${name}: refused. ${error.message}` : error);
    return 1;
  }
}

void main().then((code) => {
  process.exitCode = code;
});
