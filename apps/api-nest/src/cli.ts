import { migrate, Refusal } from './cli/migrate';
import { syncPermissions } from './cli/sync-permissions';

/**
 * The operator's commands: `node dist/cli.js <command>`.
 *
 * What `python manage.py ...` is for Django, for the things an operator does
 * to a database rather than through the API
 * (docs/architecture/django-removal-plan.md, steps 3 and 4). Each command
 * connects, does one thing and exits: 0 when it is done, 1 when it refused or
 * failed, 2 when it was not understood. None runs as the API starts.
 */
const COMMANDS: Record<
  string,
  { summary: string; run: (databaseUrl: string, log: (line: string) => void) => Promise<void> }
> = {
  migrate: {
    summary: "bring the schema to this build's; adopts a database Django built",
    run: migrate,
  },
  'sync-permissions': {
    summary: 'make the permissions, the roles and their grants what the catalogue says',
    run: syncPermissions,
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
  if (!command || rest.length) {
    console.error(usage());
    return 2;
  }
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL is not set.');
    return 2;
  }
  try {
    await command.run(databaseUrl, (line) => console.log(`${name}: ${line}`));
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
