import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  ProductSource,
  ProductSourceAction,
  ProductSourceActionRepository,
  ProductSourceActionType,
  ProductSourceActor,
  ProductSourceConfig,
  ProductSourceConfigValidatorService,
  ProductSourceRepository,
  ProductSourceVersion,
  ProductSourceVersionRepository,
  User,
} from '@fittkereso-backend/database';
import { EntityManager } from 'typeorm';

/**
 * How much history one detail response carries.
 *
 * Bounded rather than "everything", because both collections grow without an
 * upper limit: every config edit appends a version carrying a whole scrape
 * config, and every task that refuses a broken config appends an action. An
 * unbounded response would be fine for months and then quietly become
 * megabytes. The dedicated list endpoints page past these for anyone who needs
 * to go further back.
 */
const DETAIL_VERSION_LIMIT = 50;
const DETAIL_ACTION_LIMIT = 100;

export interface AddVersionOptions {
  note?: string;
  actor: ProductSourceActor;
  /** Set only by restoreVersion — the number this config was copied from. */
  restoredFromVersion?: number;
}

/**
 * Canonical JSON: the same document always produces the same string.
 *
 * Key-sorted rather than a bare JSON.stringify, and that is the whole point.
 * jsonb does not preserve key order, so a config round-tripped through the
 * database can come back with its keys rearranged without anybody touching it.
 * Compared naively, that reads as a change — and every save would then append
 * a version whose diff against the last one is nothing at all.
 */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }

  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(',')}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    // Undefined members vanish through jsonb, so a key carrying one is not a
    // difference from a config that never had the key.
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));

  return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${canonical(entryValue)}`).join(',')}}`;
}

/**
 * The config history: writing a new version, and putting an old one back.
 *
 * Every config write in the system funnels through `addVersion`, so the
 * version row and `ProductSource.config` cannot disagree — they are written in
 * one transaction, and the newest row always holds what the column holds.
 *
 * The version in force is `max(version)`. There is no pointer column, because
 * a pointer would be a second claim about which config is live.
 */
@Injectable()
export class ProductSourceVersionService {
  constructor(
    private readonly productSourceRepo: ProductSourceRepository,
    private readonly versionRepo: ProductSourceVersionRepository,
    private readonly actionRepo: ProductSourceActionRepository,
    private readonly configValidator: ProductSourceConfigValidatorService,
  ) {}

  /**
   * Appends the next version, which is what saving an edited config does.
   *
   * The number is read and written inside one transaction. That alone is not
   * enough — two transactions can both read max=3 — and it is not meant to be:
   * the (source, version) unique constraint is what actually prevents two rows
   * claiming v4.
   *
   * Refused when the config matches the version in force, so the history
   * cannot fill with entries a reader has to diff to discover mean nothing.
   */
  public async addVersion(
    sourceId: string,
    config: ProductSourceConfig,
    options: AddVersionOptions,
  ): Promise<ProductSourceVersion> {
    const saved = await this.addVersionIfChanged(sourceId, config, options);

    if (!saved) {
      const current = await this.versionRepo.findCurrent(sourceId);
      throw new ConflictException(
        `This is already what version ${current?.version} says; there is nothing to save.`,
      );
    }

    return saved;
  }

  /**
   * The same, but an unchanged config is a no-op rather than an error.
   *
   * What a general update uses. The admin form posts the whole source — config
   * included — on every save, so editing only the priority would otherwise
   * fail the entire request because the config it also sent had not changed.
   * Asking explicitly for a new version is the case that deserves the 409, and
   * that is `addVersion` above.
   */
  public async addVersionIfChanged(
    sourceId: string,
    config: ProductSourceConfig,
    options: AddVersionOptions,
  ): Promise<ProductSourceVersion | null> {
    const source = await this.productSourceRepo.findOne({
      where: { id: sourceId },
      relations: { seller: true },
    });

    if (!source) {
      throw new NotFoundException('Product source not found');
    }

    // Before anything is written: a version that could never run must not
    // enter the history, where a later restore could put it back into force.
    this.configValidator.assertValid(config);

    const current = await this.versionRepo.findCurrent(sourceId);
    if (current && canonical(current.config) === canonical(config)) {
      return null;
    }

    return this.productSourceRepo.repo.manager.transaction(async (transaction) => {
      const version = new ProductSourceVersion();
      version.source = source;
      version.version = await this.versionRepo.nextVersionNumber(sourceId, transaction);
      version.config = config;
      version.note = options.note?.trim() ?? '';
      version.restoredFromVersion = options.restoredFromVersion ?? null;
      this.applyActor(version, options.actor);

      const saved = await transaction.save(version);

      // The column the scrapers actually read, updated in the same
      // transaction. Outside it, a config and the history of that config could
      // disagree for as long as the gap between two statements.
      source.config = config;
      await transaction.save(source);

      await this.recordAction(
        source,
        options.restoredFromVersion === undefined
          ? 'config_version_created'
          : 'config_restored',
        options.restoredFromVersion === undefined
          ? { version: saved.version, note: version.note }
          : {
              version: saved.version,
              restoredFromVersion: options.restoredFromVersion,
            },
        options.actor,
        transaction,
      );

      return saved;
    });
  }

  /**
   * Puts an earlier config back, as a new version.
   *
   * A copy, not a move. Restoring v2 while v5 is live writes v6 carrying v2's
   * config: v2 stays exactly where it is, v5 is still in the history, and the
   * restore is itself reversible. Renumbering or moving rows would leave the
   * sequence with a hole and an entry that changed meaning after the fact.
   */
  public async restoreVersion(
    sourceId: string,
    version: number,
    actor: ProductSourceActor,
  ): Promise<ProductSource> {
    const target = await this.versionRepo.findByVersion(sourceId, version);
    if (!target) {
      throw new NotFoundException(`Version ${version} not found for this product source`);
    }

    const current = await this.versionRepo.findCurrent(sourceId);
    if (current && current.version === target.version) {
      throw new ConflictException(`Version ${version} is already the one in force.`);
    }

    await this.addVersion(sourceId, target.config, {
      actor,
      note: `Restored from version ${target.version}`,
      restoredFromVersion: target.version,
    });

    // The whole source, for the same reason an update answers with it: the
    // page re-renders from this response, and a restore changes the config in
    // force as well as the history.
    return this.getDetail(sourceId);
  }

  /**
   * A source with its config history and audit trail attached, newest first.
   *
   * The one shape the details page consumes: a read, a save and a restore all
   * answer with this, so the page never has to fetch the history separately —
   * and an update cannot answer with a source whose history is one request out
   * of date.
   *
   * Loaded as three queries rather than one with two `relations`: joining two
   * one-to-many collections multiplies them into a cartesian product, so a
   * source with 40 versions and 300 actions would read 12,000 rows to render
   * 340.
   */
  public async getDetail(sourceId: string): Promise<ProductSource> {
    const source = await this.productSourceRepo.findOne({
      where: { id: sourceId },
      relations: { seller: true },
    });

    if (!source) {
      throw new NotFoundException('Product source not found');
    }

    const [versions] = await this.versionRepo.listForSource(sourceId, {
      take: DETAIL_VERSION_LIMIT,
    });
    const [actions] = await this.actionRepo.listForSource(sourceId, {
      take: DETAIL_ACTION_LIMIT,
    });

    source.versions = versions;
    source.actions = actions;

    return source;
  }

  /** The history, newest first. */
  public async listVersions(
    sourceId: string,
    options: { skip?: number; take?: number } = {},
  ): Promise<[ProductSourceVersion[], number]> {
    await this.assertSourceExists(sourceId);
    return this.versionRepo.listForSource(sourceId, options);
  }

  /** One numbered revision, with its full config. */
  public async getVersion(
    sourceId: string,
    version: number,
  ): Promise<ProductSourceVersion> {
    const found = await this.versionRepo.findByVersion(sourceId, version);
    if (!found) {
      throw new NotFoundException(`Version ${version} not found for this product source`);
    }
    return found;
  }

  /** The audit timeline, newest first. */
  public async listActions(
    sourceId: string,
    options: { skip?: number; take?: number; types?: string[] } = {},
  ): Promise<[ProductSourceAction[], number]> {
    await this.assertSourceExists(sourceId);
    return this.actionRepo.listForSource(sourceId, options);
  }

  /**
   * Records one audit entry.
   *
   * Public so the other services that change a source — the update service,
   * the sync trigger, the run-time config guard — write their history the same
   * way, with attribution they cannot forge: actor and time come from here,
   * never from a request body.
   */
  public async recordAction(
    source: ProductSource,
    type: ProductSourceActionType,
    payload: Record<string, unknown>,
    actor: ProductSourceActor,
    transaction?: EntityManager,
  ): Promise<ProductSourceAction> {
    const action = new ProductSourceAction();
    action.source = source;
    action.type = type;
    action.payload = payload;
    action.occurredAt = new Date();
    this.applyActor(action, actor);

    return this.actionRepo.record(action, transaction);
  }

  /**
   * Stamps the actor triple onto a history row.
   *
   * In one place so no call site can set two of the three and forget the
   * third, and so `actorType` is always stated rather than inferred from
   * whether a user id happens to be present.
   */
  private applyActor(
    row: { actorType: ProductSourceActor['type']; actorUser?: User | null; actorLabel?: string | null },
    actor: ProductSourceActor,
  ): void {
    row.actorType = actor.type;
    row.actorLabel = actor.label ?? null;

    if (actor.type === 'user') {
      if (!actor.userId) {
        throw new BadRequestException('A user action must name the user who made it');
      }
      // Assigned as a reference rather than loaded: TypeORM writes the FK from
      // the id alone, and this row never reads the rest of the account.
      row.actorUser = { id: actor.userId } as User;
      return;
    }

    row.actorUser = null;
  }

  private async assertSourceExists(sourceId: string): Promise<void> {
    const exists = await this.productSourceRepo.findOne({ where: { id: sourceId } });
    if (!exists) {
      throw new NotFoundException('Product source not found');
    }
  }
}
