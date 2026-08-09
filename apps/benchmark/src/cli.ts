export interface CliArgs {
  help: boolean;
  scenario?: string;
  suite: boolean;
  phase?: string;
  runs?: number;
  noJudge: boolean;
  dryRun: boolean;
  noFetch: boolean;
}

export function parseCliArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    help: false,
    suite: false,
    noJudge: false,
    dryRun: false,
    noFetch: false,
  };

  // Normalize "--flag=value" into separate ["--flag", "value"] tokens so the
  // switch statement below handles both forms uniformly.
  const tokens: string[] = [];
  for (const raw of argv) {
    const eq = raw.indexOf('=');
    if (raw.startsWith('--') && eq > 2) {
      tokens.push(raw.slice(0, eq), raw.slice(eq + 1));
    } else {
      tokens.push(raw);
    }
  }

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    switch (token) {
      case '-h':
      case '--help':
        args.help = true;
        break;
      case '--scenario':
        args.scenario = expectValue(tokens, ++i, '--scenario');
        break;
      case '--suite':
        args.suite = true;
        break;
      case '--phase':
        args.phase = expectValue(tokens, ++i, '--phase');
        break;
      case '--runs': {
        const value = expectValue(tokens, ++i, '--runs');
        const parsed = Number.parseInt(value, 10);
        if (!Number.isFinite(parsed) || parsed <= 0) {
          throw new Error(`--runs must be a positive integer, got: ${value}`);
        }
        args.runs = parsed;
        break;
      }
      case '--no-judge':
        args.noJudge = true;
        break;
      case '--dry-run':
        args.dryRun = true;
        break;
      case '--no-fetch':
        args.noFetch = true;
        break;
      default:
        throw new Error(`Unknown argument: ${token}`);
    }
  }

  if (!args.help && !args.scenario && !args.suite) {
    throw new Error('Must provide either --scenario <id> or --suite');
  }

  return args;
}

function expectValue(tokens: string[], index: number, flag: string): string {
  const value = tokens[index];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

export function printUsage(): void {
  // eslint-disable-next-line no-console
  console.log(
    [
      'benchmark — prompt-tuning harness for the thread extraction pipeline',
      '',
      'Usage:',
      '  nx run benchmark:run -- --scenario <scenario-id>',
      '  nx run benchmark:run -- --suite [--phase <phase>]',
      '',
      'Flags:',
      '  --scenario <id>   Run a single scenario by id (matches scenarios/**/<id>.scenario.json)',
      '  --suite           Run every scenario found under apps/benchmark/scenarios/',
      '  --phase <p>       Filter to one phase (identification | extraction | labeling | validation | op-summary | disambiguation)',
      '  --runs <n>        Override scenario.runs.perCandidate for this invocation',
      '  --no-judge        Skip the LLM judge layer (deterministic checks only)',
      '  --dry-run         Print the assembled prompts without making any LLM calls',
      '  --no-fetch        Fail real-thread inputs whose comment tree is missing or stale (no Reddit fetch)',
      '  -h, --help        Show this message',
    ].join('\n'),
  );
}
