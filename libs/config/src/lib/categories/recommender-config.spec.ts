import * as fs from 'fs';
import * as path from 'path';
import {
  type RecommenderSchemaProperty,
  validateRecommender,
} from './recommender-validation';

// Every category directory with a recommender.json, read from disk so a new
// one is covered without touching this spec.
const categories = fs
  .readdirSync(__dirname, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .filter((slug) =>
    fs.existsSync(path.join(__dirname, slug, 'recommender.json')),
  );

const read = (slug: string, file: string) =>
  JSON.parse(fs.readFileSync(path.join(__dirname, slug, file), 'utf8'));

describe.each(categories)('the %s recommender', (slug) => {
  it('names only specs and values its category schema has', () => {
    const properties = read(slug, 'jsonSchema.json').properties;
    expect(
      validateRecommender(read(slug, 'recommender.json'), properties),
    ).toEqual([]);
  });
});

// Fixtures are malformed on purpose, so they are not typed.
type Fixture = any;

describe('validateRecommender', () => {
  const properties: Record<string, RecommenderSchemaProperty> = {
    kind: { type: 'string', enum: ['City', 'MTB'] },
    maker: { type: 'string' },
    power: { type: 'number' },
    abs: { type: 'boolean' },
  };
  const text = { hu: 'x', en: 'x' };
  const choice = (id: string, options: object[], extra: object = {}) => ({
    id,
    type: 'single',
    question: text,
    options,
    ...extra,
  });
  const option = (id: string, extra: object = {}) => ({
    id,
    label: text,
    ...extra,
  });
  const valid = (): Fixture => ({
    title: text,
    steps: [
      choice('usage', [
        option('city', {
          set: [{ spec: 'kind', in: ['City'], importance: 'high' }],
          values: { whPerKm: 6 },
        }),
        option('trail', {
          set: [
            {
              spec: 'kind',
              in: ['MTB'],
              partial: { City: 0.3 },
              importance: 'high',
            },
          ],
        }),
      ]),
      choice('distance', [option('short', { values: { km: 20 } })], {
        showIf: [{ step: 'usage', noneOf: ['trail'] }],
      }),
    ],
    derived: [
      {
        spec: 'power',
        op: 'gte',
        importance: 'medium',
        multiply: [
          { answer: 'distance', value: 'km' },
          { answer: 'usage', value: 'whPerKm', default: 8 },
          1.35,
        ],
      },
    ],
  });
  const errorsOf = (rec: object) => validateRecommender(rec, properties);
  const expectError = (rec: object, fragment: string) =>
    expect(errorsOf(rec).join('\n')).toContain(fragment);

  it('accepts a valid file', () => {
    expect(errorsOf(valid())).toEqual([]);
  });

  it('rejects a file of the wrong shape: a missing locale, a bad id', () => {
    const rec = valid();
    rec.title = { hu: 'x' };
    expectError(rec, 'shape:');
    const badId = valid();
    badId.steps[0].id = 'Usage';
    expectError(badId, 'shape:');
  });

  it('rejects duplicate and reserved ids', () => {
    const rec = valid();
    rec.steps[1].id = 'usage';
    expectError(rec, 'duplicate step id');
    const dupOption = valid();
    dupOption.steps[0].options.push(option('city'));
    expectError(dupOption, 'duplicate option id city');
    const reserved = valid();
    reserved.steps[1].id = 'step';
    expectError(reserved, 'reserved step id');
  });

  it('rejects a schema property named like a pseudo-spec', () => {
    expect(
      validateRecommender(valid(), {
        ...properties,
        '@x': { type: 'string' },
      }).join('\n'),
    ).toContain('collides with the pseudo-spec prefix');
  });

  it('rejects an unknown spec, and accepts the pseudo-specs', () => {
    const rec = valid();
    rec.steps[0].options[0].set = [
      { spec: 'nope', in: ['City'], importance: 'high' },
    ];
    expectError(rec, 'unknown spec nope');
    const pseudo = valid();
    pseudo.steps[0].options[0].set = [
      { spec: '@price', lte: 1000, importance: 'high' },
      { spec: '@brand', in: ['KTM'], importance: 'low' },
    ];
    expect(errorsOf(pseudo)).toEqual([]);
  });

  it('rejects a constraint that does not fit the spec type or enum', () => {
    const cases: [object, string][] = [
      [
        { spec: 'kind', in: ['Road'], importance: 'high' },
        'kind has no value "Road"',
      ],
      [
        {
          spec: 'kind',
          in: ['City'],
          partial: { Road: 0.5 },
          importance: 'high',
        },
        'kind has no value "Road"',
      ],
      [{ spec: 'power', in: ['5'], importance: 'high' }, '"in" on power'],
      [{ spec: 'kind', gte: 5, importance: 'high' }, 'a numeric bound on kind'],
      [{ spec: 'power', between: [9, 1], importance: 'high' }, 'is backwards'],
      [{ spec: 'power', is: true, importance: 'high' }, '"is" on power'],
    ];
    for (const [effect, fragment] of cases) {
      const rec = valid();
      rec.steps[0].options[0].set = [effect];
      expectError(rec, fragment);
    }
    // A free-text spec has no enum to check against.
    const free = valid();
    free.steps[0].options[0].set = [
      { spec: 'maker', in: ['Bosch'], importance: 'low' },
    ];
    expect(errorsOf(free)).toEqual([]);
  });

  it('rejects an invalid or conflicting assumeWhenMissing', () => {
    const rec = valid();
    rec.steps[0].options[0].set = [
      {
        spec: 'kind',
        in: ['City'],
        importance: 'high',
        assumeWhenMissing: 'Road',
      },
    ];
    expectError(rec, 'is not a value of kind');
    const conflict = valid();
    conflict.steps[0].options[0].set = [
      {
        spec: 'kind',
        in: ['City'],
        importance: 'high',
        assumeWhenMissing: 'City',
      },
    ];
    conflict.steps[0].options[1].set = [
      {
        spec: 'kind',
        in: ['MTB'],
        importance: 'high',
        assumeWhenMissing: 'MTB',
      },
    ];
    expectError(conflict, 'is assumed "MTB" here and "City" elsewhere');
  });

  it('rejects a showIf naming a later step or an unknown option', () => {
    const rec = valid();
    rec.steps[0].showIf = [{ step: 'distance', anyOf: ['short'] }];
    expectError(rec, 'not an earlier step');
    const unknown = valid();
    unknown.steps[1].showIf = [{ step: 'usage', anyOf: ['road'] }];
    expectError(unknown, 'showIf names usage.road, no such option');
  });

  it('rejects a default or maxChoices that does not fit the step', () => {
    const rec = valid();
    rec.steps[0].default = 'nope';
    expectError(rec, 'default nope is not an option');
    const conditional = valid();
    conditional.steps[1].default = 'short';
    conditional.steps[1].options[0].showIf = [
      { step: 'usage', anyOf: ['city'] },
    ];
    expectError(conditional, 'default short has a showIf');
    const max = valid();
    max.steps[0].maxChoices = 2;
    expectError(max, 'maxChoices on a single step');
  });

  it('rejects number steps with bad bounds or overlapping bands', () => {
    const numberStep = (
      bands: object[],
      number = { min: 140, max: 210, step: 1, initial: 175, unit: text },
    ) => ({
      id: 'height',
      type: 'number',
      question: text,
      number,
      bands,
    });
    const withStep = (step: object) => ({
      ...valid(),
      steps: [...valid().steps, step],
    });
    expect(
      errorsOf(withStep(numberStep([{ max: 170 }, { min: 170 }]))),
    ).toEqual([]);
    expectError(
      withStep(numberStep([{ max: 175 }, { min: 170 }])),
      'overlap or are out of order',
    );
    // Bands under different conditions may cover the same numbers.
    expect(
      errorsOf(
        withStep(
          numberStep([
            { max: 175, showIf: [{ step: 'usage', anyOf: ['trail'] }] },
            { max: 175, showIf: [{ step: 'usage', noneOf: ['trail'] }] },
          ]),
        ),
      ),
    ).toEqual([]);
    expectError(
      withStep(
        numberStep([{}], { min: 5, max: 1, step: 1, initial: 3, unit: text }),
      ),
      'is not below max',
    );
  });

  it('rejects derived parameters reading values no step has', () => {
    const rec = valid();
    rec.derived[0].multiply = [{ answer: 'distance', value: 'miles' }];
    expectError(rec, 'no option of distance has values.miles');
    const noStep = valid();
    noStep.derived[0].multiply = [{ answer: 'nope', value: 'km' }];
    expectError(noStep, 'factor names nope, no such step');
    const textSpec = valid();
    textSpec.derived[0].spec = 'kind';
    expectError(textSpec, 'kind is a string spec');
    // A number step's factor is its number, or a value of its bands.
    const withHeight = valid();
    withHeight.steps.push({
      id: 'height',
      type: 'number',
      question: text,
      number: { min: 140, max: 210, step: 1, initial: 175, unit: text },
      bands: [{ max: 170, values: { factor: 0.9 } }, { min: 170 }],
    });
    withHeight.derived[0].multiply = [
      { answer: 'height' },
      { answer: 'height', value: 'factor' },
    ];
    expect(errorsOf(withHeight)).toEqual([]);
    withHeight.derived[0].multiply = [{ answer: 'height', value: 'nope' }];
    expectError(withHeight, 'no band of height has values.nope');
  });

  it('rejects raising a spec no answer sets', () => {
    const rec = valid();
    rec.steps[1].options[0].raise = ['abs'];
    expectError(rec, 'raises abs, which no answer sets');
    rec.steps[1].options[0].raise = ['kind'];
    expect(errorsOf(rec)).toEqual([]);
  });
});
