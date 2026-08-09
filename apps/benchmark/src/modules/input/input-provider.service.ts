import { Injectable } from '@nestjs/common';
import { LoadedScenario, ResolvedInputEntry } from '../scenario/scenario.types';
import { ResolvedPhaseCase } from './input.types';
import { RealThreadInputService } from './real-thread-input.service';
import { FixtureInputService } from './fixture-input.service';

@Injectable()
export class InputProviderService {
  constructor(
    private readonly realThread: RealThreadInputService,
    private readonly fixture: FixtureInputService,
  ) {}

  async build(
    loaded: LoadedScenario,
    options: { noFetch: boolean },
  ): Promise<ResolvedPhaseCase[]> {
    const results = await Promise.all(
      loaded.inputEntries.map((entry) => this.buildForEntry(entry, loaded, options)),
    );
    return results.flat();
  }

  private async buildForEntry(
    entry: ResolvedInputEntry,
    loaded: LoadedScenario,
    options: { noFetch: boolean },
  ): Promise<ResolvedPhaseCase[]> {
    const input = entry.input;
    let cases: ResolvedPhaseCase[];
    switch (input.kind) {
      case 'real-thread':
        cases = await this.realThread.build(input, entry.subtreeCases, options);
        break;
      case 'fixture':
        cases = this.fixture.build(input, entry.subtreeCases, loaded.sourcePath);
        break;
      default: {
        const _exhaustive: never = input;
        throw new Error(`Unknown input kind: ${JSON.stringify(_exhaustive)}`);
      }
    }
    return cases;
  }
}
