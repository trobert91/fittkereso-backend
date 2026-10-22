import Ajv from 'ajv';
import * as fs from 'fs';
import * as path from 'path';

// What recommender-config.spec.ts checks a category's recommender.json against. The file is read
// only by the public website (a resolved copy, fittkereso-frontend/src/config/recommenders/), so
// nothing here runs in the apps: a spec name or value that no longer exists would silently match
// nothing on the site, which is what these checks are for.

export type RecommenderSchemaProperty = { type: string; enum?: string[] };

type Text = { hu: string; en: string };
type Condition = { step: string; anyOf?: string[]; noneOf?: string[] };
type Constraint = {
  in?: string[];
  partial?: Record<string, number>;
  gte?: number;
  lte?: number;
  between?: [number, number];
  is?: true;
  tolerance?: number;
};
type Alternative = Constraint & { spec: string };
type Effect = Constraint & {
  spec?: string;
  importance: string;
  assumeWhenMissing?: string | number | boolean;
  anyOf?: Alternative[];
};
type Option = {
  id: string;
  label: Text;
  showIf?: Condition[];
  set?: Effect[];
  values?: Record<string, number>;
  raise?: string[];
};
type Band = {
  min?: number;
  max?: number;
  showIf?: Condition[];
  set?: Effect[];
  values?: Record<string, number>;
};
type Step = {
  id: string;
  type: 'single' | 'multi' | 'number';
  maxChoices?: number;
  default?: string;
  showIf?: Condition[];
  options?: Option[];
  number?: { min: number; max: number; step: number; initial: number };
  bands?: Band[];
};
type Derived = {
  spec: string;
  op: 'gte' | 'lte';
  multiply: (number | { answer: string; value?: string; default?: number })[];
  clamp?: [number, number];
};
export type RecommenderFile = { steps: Step[]; derived?: Derived[] };

/** The specs every category has besides its schema's: the lowest current offer price, the brand name. */
export const PSEUDO_SPECS: Record<string, RecommenderSchemaProperty> = {
  '@price': { type: 'number' },
  '@brand': { type: 'string' },
};

/** Step ids the site's query string already uses: the stepper's cursor, and the listing's usage-type key. */
const RESERVED_STEP_IDS = ['step', 'usageType'];

const schema = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'recommender.schema.json'), 'utf8'),
);
const validateShape = new Ajv({ allErrors: true }).compile(schema);

/** Every problem with one category's recommender.json, as readable lines; none when it is valid. */
export function validateRecommender(
  rec: unknown,
  properties: Record<string, RecommenderSchemaProperty>,
): string[] {
  if (!validateShape(rec)) {
    return (validateShape.errors ?? []).map(
      (e) => `shape: ${e.instancePath || '/'} ${e.message}`,
    );
  }
  const file = rec as RecommenderFile;
  const errors: string[] = [];
  const specs = { ...properties, ...PSEUDO_SPECS };

  for (const key of Object.keys(properties)) {
    if (key.startsWith('@'))
      errors.push(
        `schema property ${key} collides with the pseudo-spec prefix @`,
      );
  }

  // Ids.
  const stepIds = new Set<string>();
  for (const step of file.steps) {
    if (stepIds.has(step.id)) errors.push(`step ${step.id}: duplicate step id`);
    stepIds.add(step.id);
    if (RESERVED_STEP_IDS.includes(step.id))
      errors.push(`step ${step.id}: reserved step id`);
    const optionIds = new Set<string>();
    for (const option of step.options ?? []) {
      if (optionIds.has(option.id))
        errors.push(`step ${step.id}: duplicate option id ${option.id}`);
      optionIds.add(option.id);
    }
  }

  // Effects: the spec exists and the constraint fits its type.
  const assumed = new Map<string, string | number | boolean>();
  const usedSpecs = new Set<string>();
  const checkConstraint = (where: string, spec: string, c: Constraint) => {
    usedSpecs.add(spec);
    const property = specs[spec];
    if (!property) {
      errors.push(`${where}: unknown spec ${spec}`);
      return;
    }
    if (c.in) {
      if (property.type !== 'string')
        errors.push(`${where}: "in" on ${spec}, a ${property.type} spec`);
      const values = [...c.in, ...Object.keys(c.partial ?? {})];
      for (const value of values) {
        if (property.enum && !property.enum.includes(value))
          errors.push(`${where}: ${spec} has no value "${value}"`);
      }
      if (c.tolerance !== undefined)
        errors.push(`${where}: tolerance on an "in" constraint`);
    } else if (c.gte !== undefined || c.lte !== undefined || c.between) {
      if (property.type !== 'number')
        errors.push(
          `${where}: a numeric bound on ${spec}, a ${property.type} spec`,
        );
      if (c.between && c.between[0] > c.between[1])
        errors.push(`${where}: between [${c.between}] is backwards`);
    } else if (c.is) {
      if (property.type !== 'boolean')
        errors.push(`${where}: "is" on ${spec}, a ${property.type} spec`);
    }
    if (c.partial && !c.in) errors.push(`${where}: partial without "in"`);
  };
  const checkEffects = (where: string, effects: Effect[] = []) => {
    for (const effect of effects) {
      if (effect.anyOf) {
        effect.anyOf.forEach((alt, i) =>
          checkConstraint(`${where} anyOf[${i}]`, alt.spec, alt),
        );
        continue;
      }
      const spec = effect.spec;
      if (!spec) continue; // the shape check requires it
      checkConstraint(where, spec, effect);
      if (effect.assumeWhenMissing !== undefined) {
        const property = specs[spec];
        const value = effect.assumeWhenMissing;
        if (property && typeof value !== property.type) {
          errors.push(
            `${where}: assumeWhenMissing ${JSON.stringify(value)} is not a ${property.type}`,
          );
        } else if (property?.enum && !property.enum.includes(String(value))) {
          errors.push(
            `${where}: assumeWhenMissing "${value}" is not a value of ${spec}`,
          );
        }
        const earlier = assumed.get(spec);
        if (earlier !== undefined && earlier !== value) {
          errors.push(
            `${where}: ${spec} is assumed ${JSON.stringify(value)} here and ${JSON.stringify(earlier)} elsewhere`,
          );
        }
        assumed.set(spec, value);
      }
    }
  };

  // Conditions name an earlier choice step and its options.
  const seen = new Map<string, Step>();
  const checkShowIf = (where: string, showIf: Condition[] = []) => {
    for (const condition of showIf) {
      const target = seen.get(condition.step);
      if (!target) {
        errors.push(
          `${where}: showIf names ${condition.step}, not an earlier step`,
        );
        continue;
      }
      if (target.type === 'number') {
        errors.push(`${where}: showIf names ${condition.step}, a number step`);
        continue;
      }
      for (const id of [
        ...(condition.anyOf ?? []),
        ...(condition.noneOf ?? []),
      ]) {
        if (!target.options?.some((o) => o.id === id))
          errors.push(
            `${where}: showIf names ${condition.step}.${id}, no such option`,
          );
      }
    }
  };

  for (const step of file.steps) {
    const at = `step ${step.id}`;
    checkShowIf(at, step.showIf);
    if (step.type === 'number' && step.number) {
      const n = step.number;
      if (!(n.min < n.max))
        errors.push(`${at}: number min ${n.min} is not below max ${n.max}`);
      if (n.initial < n.min || n.initial > n.max)
        errors.push(
          `${at}: initial ${n.initial} is outside [${n.min}, ${n.max}]`,
        );
      const groups = new Map<string, Band[]>();
      (step.bands ?? []).forEach((band, i) => {
        checkShowIf(`${at} band ${i}`, band.showIf);
        checkEffects(`${at} band ${i}`, band.set);
        if (
          band.min !== undefined &&
          band.max !== undefined &&
          !(band.min < band.max)
        ) {
          errors.push(`${at} band ${i}: [${band.min}, ${band.max}) is empty`);
        }
        const key = JSON.stringify(band.showIf ?? []);
        groups.set(key, [...(groups.get(key) ?? []), band]);
      });
      for (const bands of groups.values()) {
        for (let i = 1; i < bands.length; i++) {
          const prev = bands[i - 1];
          const next = bands[i];
          if (
            prev.max === undefined ||
            next.min === undefined ||
            prev.max > next.min
          ) {
            errors.push(
              `${at}: bands [${prev.min}, ${prev.max}) and [${next.min}, ${next.max}) overlap or are out of order`,
            );
          }
        }
      }
    } else {
      if (step.default !== undefined) {
        const option = step.options?.find((o) => o.id === step.default);
        if (step.type !== 'single')
          errors.push(`${at}: default on a ${step.type} step`);
        if (!option)
          errors.push(`${at}: default ${step.default} is not an option`);
        else if (option.showIf)
          errors.push(`${at}: default ${step.default} has a showIf`);
      }
      if (step.maxChoices !== undefined) {
        if (step.type !== 'multi')
          errors.push(`${at}: maxChoices on a ${step.type} step`);
        if (step.maxChoices > (step.options?.length ?? 0))
          errors.push(`${at}: maxChoices exceeds the options`);
      }
      for (const option of step.options ?? []) {
        checkShowIf(`${at} option ${option.id}`, option.showIf);
        checkEffects(`${at} option ${option.id}`, option.set);
      }
    }
    seen.set(step.id, step);
  }

  // Derived parameters multiply values the steps define.
  for (const [i, derived] of (file.derived ?? []).entries()) {
    const at = `derived ${i} (${derived.spec})`;
    usedSpecs.add(derived.spec);
    const property = specs[derived.spec];
    if (!property) errors.push(`${at}: unknown spec ${derived.spec}`);
    else if (property.type !== 'number')
      errors.push(`${at}: ${derived.spec} is a ${property.type} spec`);
    if (derived.clamp && derived.clamp[0] > derived.clamp[1])
      errors.push(`${at}: clamp [${derived.clamp}] is backwards`);
    for (const factor of derived.multiply) {
      if (typeof factor === 'number') continue;
      const step = seen.get(factor.answer);
      if (!step) {
        errors.push(`${at}: factor names ${factor.answer}, no such step`);
        continue;
      }
      const key = factor.value;
      // A number step's factor is the number itself, or a value of the band it falls in.
      if (step.type === 'number') {
        if (
          key !== undefined &&
          !(step.bands ?? []).some((b) => b.values?.[key] !== undefined)
        ) {
          errors.push(`${at}: no band of ${factor.answer} has values.${key}`);
        }
        continue;
      }
      if (key === undefined) {
        errors.push(
          `${at}: factor of choice step ${factor.answer} names no value`,
        );
      } else if (
        !(step.options ?? []).some((o) => o.values?.[key] !== undefined)
      ) {
        errors.push(
          `${at}: no option of ${factor.answer} has values.${factor.value}`,
        );
      }
    }
  }

  // Raised specs are ones some parameter sets.
  for (const step of file.steps) {
    for (const option of step.options ?? []) {
      for (const spec of option.raise ?? []) {
        if (!usedSpecs.has(spec))
          errors.push(
            `step ${step.id} option ${option.id}: raises ${spec}, which no answer sets`,
          );
      }
    }
  }
  return errors;
}
