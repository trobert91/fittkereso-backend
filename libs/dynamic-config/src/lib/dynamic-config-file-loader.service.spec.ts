import * as path from 'path';
import { DynamicConfigFileLoaderService } from './dynamic-config-file-loader.service';
import { DynamicConfigValidatorService } from './dynamic-config-validator.service';

/**
 * Loads the config files the repo actually ships, from the repo root the apps
 * run in. A section the loader forgets to read silently falls back to its code
 * defaults — that is how `offers` went unread while its docs promised it could
 * be changed without a code change.
 */
describe('DynamicConfigFileLoaderService', () => {
  const repoRoot = path.resolve(__dirname, '../../../..');

  let data: ReturnType<DynamicConfigFileLoaderService['getData']>;

  beforeAll(() => {
    const cwd = jest.spyOn(process, 'cwd').mockReturnValue(repoRoot);
    data = new DynamicConfigFileLoaderService(
      new DynamicConfigValidatorService(),
    ).getData();
    cwd.mockRestore();
  });

  it('reads offers.json', () => {
    expect(data.offers).toEqual({
      freshnessDays: 3,
      deleteAfterDays: 14,
      deletionEnabled: true,
      completeSourceRemovalEnabled: true,
    });
  });

  it('reads import.json', () => {
    expect(data.import?.listRefreshRequiredFields).toEqual([
      'url',
      'price',
      'availability',
    ]);
  });

  it('still reads the sections it read before', () => {
    expect(data.scheduling).toBeDefined();
    expect(data.translation).toBeDefined();
  });
});
