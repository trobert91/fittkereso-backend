import { ConflictException, NotFoundException } from '@nestjs/common';
import {
  ProductSourceConfigValidatorService,
  type ProductSource,
  type ScrapingSourceConfig,
  type ProductSourceVersion,
} from '@fittkereso-backend/database';
import { ProductSourceVersionService } from './product-source-version.service';

const CONFIG = {
  baseUrl: 'https://example.com',
  startUrls: ['https://example.com/products'],
  listPage: {
    categoryName: [{ op: 'selectText', selector: 'h1' }],
    items: [{ op: 'selectAll', selector: 'a.product' }],
    itemMode: 'cheerio',
    itemPipeline: [
      {
        op: 'assembleListProduct',
        url: [{ op: 'selectAttr', selector: 'a', attr: 'href', within: 'item' }],
      },
    ],
  },
  detailPage: {
    rawSpecs: [{ op: 'selectAll', selector: 'tr' }],
    category: {
      breadcrumbOrSource: [{ op: 'selectText', selector: '.crumb' }],
      slugLookup: [{ when: { always: true }, slug: 'ebikes' }],
    },
    brand: [{ op: 'selectText', selector: '.brand' }],
    model: [{ op: 'selectText', selector: '.model' }],
    images: [{ op: 'extractAttrList', attr: 'src' }],
    specMapping: { ebikes: { mappings: [{ key: 'motorBrand', labels: ['Motor'] }] } },
  },
} as unknown as ScrapingSourceConfig;

const SOURCE = {
  id: 'source-1',
  name: 'speedbike',
  type: 'scraping' as const,
  config: CONFIG,
} as ProductSource;

const ACTOR = { type: 'user' as const, userId: 'user-1', label: 'admin@example.com' };
const SYSTEM_ACTOR = { type: 'system' as const, label: 'seed' };

/** What the repositories hand back when getDetail attaches the history. */
const HISTORY_VERSIONS = [{ id: 'v-6', version: 6 }] as unknown as ProductSourceVersion[];
const HISTORY_ACTIONS = [{ id: 'a-1', type: 'config_restored' }] as never[];

describe('ProductSourceVersionService', () => {
  let service: ProductSourceVersionService;
  let sourceRepo: any;
  let versionRepo: any;
  let actionRepo: any;
  let transaction: any;
  let saved: any[];

  beforeEach(() => {
    saved = [];
    transaction = {
      save: jest.fn(async (entity: any) => {
        saved.push(entity);
        return entity;
      }),
      getRepository: jest.fn(),
    };

    sourceRepo = {
      findOne: jest.fn().mockResolvedValue({ ...SOURCE }),
      repo: {
        manager: {
          transaction: jest.fn(async (run: any) => run(transaction)),
        },
      },
    };

    versionRepo = {
      findCurrent: jest.fn().mockResolvedValue(null),
      findByVersion: jest.fn().mockResolvedValue(null),
      nextVersionNumber: jest.fn().mockResolvedValue(1),
      listForSource: jest.fn().mockResolvedValue([HISTORY_VERSIONS, HISTORY_VERSIONS.length]),
    };

    actionRepo = {
      record: jest.fn(async (action: any) => action),
      listForSource: jest.fn().mockResolvedValue([HISTORY_ACTIONS, HISTORY_ACTIONS.length]),
    };

    service = new ProductSourceVersionService(
      sourceRepo,
      versionRepo,
      actionRepo,
      new ProductSourceConfigValidatorService(),
    );
  });

  const versionRows = (): ProductSourceVersion[] =>
    saved.filter((entity) => 'version' in entity);

  describe('addVersion', () => {
    it('writes version 1 for a source with no history', async () => {
      const version = await service.addVersion(SOURCE.id, CONFIG, { actor: ACTOR });

      expect(version.version).toBe(1);
      expect(version.config).toEqual(CONFIG);
    });

    it('updates the source config in the same transaction as the version', async () => {
      await service.addVersion(SOURCE.id, CONFIG, { actor: ACTOR });

      // Both the version row and the source went through the transaction's
      // save — a config and its history must not be able to disagree.
      expect(versionRows()).toHaveLength(1);
      expect(saved.some((entity) => entity.config === CONFIG && 'name' in entity)).toBe(
        true,
      );
    });

    it('numbers the next version above the one in force', async () => {
      versionRepo.findCurrent.mockResolvedValue({ version: 5, config: { other: true } });
      versionRepo.nextVersionNumber.mockResolvedValue(6);

      const version = await service.addVersion(SOURCE.id, CONFIG, { actor: ACTOR });

      expect(version.version).toBe(6);
    });

    it('records who made it, and freezes their label', async () => {
      const version = await service.addVersion(SOURCE.id, CONFIG, { actor: ACTOR });

      expect(version.actorType).toBe('user');
      expect(version.actorUser).toEqual({ id: 'user-1' });
      expect(version.actorLabel).toBe('admin@example.com');
    });

    it('records a system actor without a user', async () => {
      const version = await service.addVersion(SOURCE.id, CONFIG, {
        actor: SYSTEM_ACTOR,
      });

      expect(version.actorType).toBe('system');
      expect(version.actorUser).toBeNull();
      expect(version.actorLabel).toBe('seed');
    });

    it('writes a config_version_created action alongside the version', async () => {
      await service.addVersion(SOURCE.id, CONFIG, { actor: ACTOR, note: 'first' });

      const action = actionRepo.record.mock.calls[0][0];
      expect(action.type).toBe('config_version_created');
      expect(action.payload).toEqual({ version: 1, note: 'first' });
      // The config lives on the version row, never duplicated into the trail.
      expect(action.payload).not.toHaveProperty('config');
    });

    it('refuses a config that does not match the schema', async () => {
      const broken = JSON.parse(JSON.stringify(CONFIG));
      broken.listPage.items[0].op = 'selectTxt';

      await expect(service.addVersion(SOURCE.id, broken, { actor: ACTOR })).rejects.toThrow(
        /selectTxt/,
      );
      expect(versionRows()).toHaveLength(0);
    });

    it('refuses an unchanged config', async () => {
      versionRepo.findCurrent.mockResolvedValue({ version: 3, config: CONFIG });

      await expect(
        service.addVersion(SOURCE.id, CONFIG, { actor: ACTOR }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    // jsonb does not preserve key order, so a config round-tripped through the
    // database can come back reordered without anybody touching it.
    it('treats a key-reordered config as unchanged', async () => {
      const reordered = {
        detailPage: CONFIG.detailPage,
        listPage: CONFIG.listPage,
        startUrls: CONFIG.startUrls,
        baseUrl: CONFIG.baseUrl,
      } as unknown as ScrapingSourceConfig;
      versionRepo.findCurrent.mockResolvedValue({ version: 3, config: CONFIG });

      await expect(
        service.addVersion(SOURCE.id, reordered, { actor: ACTOR }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('404s for a source that does not exist', async () => {
      sourceRepo.findOne.mockResolvedValue(null);

      await expect(
        service.addVersion('missing', CONFIG, { actor: ACTOR }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('addVersionIfChanged', () => {
    // The admin form posts the whole source on every save, so an unchanged
    // config must not fail an edit to some unrelated field.
    it('returns null instead of throwing when nothing changed', async () => {
      versionRepo.findCurrent.mockResolvedValue({ version: 3, config: CONFIG });

      await expect(
        service.addVersionIfChanged(SOURCE.id, CONFIG, { actor: ACTOR }),
      ).resolves.toBeNull();
      expect(versionRows()).toHaveLength(0);
    });
  });

  describe('restoreVersion', () => {
    const OLD_CONFIG = {
      ...CONFIG,
      baseUrl: 'https://old.example.com',
    } as ScrapingSourceConfig;

    beforeEach(() => {
      versionRepo.findByVersion.mockResolvedValue({
        id: 'version-2',
        version: 2,
        config: OLD_CONFIG,
      });
      versionRepo.findCurrent.mockResolvedValue({ version: 5, config: CONFIG });
      versionRepo.nextVersionNumber.mockResolvedValue(6);
    });

    it('writes a NEW highest version carrying the old config', async () => {
      await service.restoreVersion(SOURCE.id, 2, ACTOR);

      const written = versionRows()[0];
      expect(written.version).toBe(6);
      expect(written.config).toEqual(OLD_CONFIG);
    });

    it('records which version it came from', async () => {
      await service.restoreVersion(SOURCE.id, 2, ACTOR);

      const written = versionRows()[0];
      expect(written.restoredFromVersion).toBe(2);
      expect(written.note).toBe('Restored from version 2');
    });

    // The page re-renders from this response, and a restore changes both the
    // config in force and the history — so it answers with the whole source.
    it('answers with the source, history attached', async () => {
      const restored = await service.restoreVersion(SOURCE.id, 2, ACTOR);

      expect(restored.id).toBe(SOURCE.id);
      expect(restored.versions).toEqual(HISTORY_VERSIONS);
      expect(restored.actions).toEqual(HISTORY_ACTIONS);
    });

    it('writes a config_restored action rather than config_version_created', async () => {
      await service.restoreVersion(SOURCE.id, 2, ACTOR);

      const action = actionRepo.record.mock.calls[0][0];
      expect(action.type).toBe('config_restored');
      expect(action.payload).toEqual({ version: 6, restoredFromVersion: 2 });
    });

    it('refuses to restore the version already in force', async () => {
      versionRepo.findCurrent.mockResolvedValue({ version: 2, config: OLD_CONFIG });

      await expect(service.restoreVersion(SOURCE.id, 2, ACTOR)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('404s for a version this source does not have', async () => {
      versionRepo.findByVersion.mockResolvedValue(null);

      await expect(service.restoreVersion(SOURCE.id, 99, ACTOR)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('recordAction', () => {
    it('stamps the actor and the time it happened', async () => {
      const action = await service.recordAction(
        SOURCE,
        'sync_triggered',
        { mode: 'full' },
        ACTOR,
      );

      expect(action.actorType).toBe('user');
      expect(action.actorLabel).toBe('admin@example.com');
      expect(action.occurredAt).toBeInstanceOf(Date);
    });
  });
});
