import {
  ListingMatchLlmQuery,
  ListingMatchLlmService,
} from './listing-match-llm.service';
import type { ProductCandidate } from './types';

const FIRST_ID = '11111111-1111-1111-1111-111111111111';
const SECOND_ID = '22222222-2222-2222-2222-222222222222';

const QUERY: ListingMatchLlmQuery = {
  brandName: 'KTM',
  model: 'Macina Kapoho Master',
  displayName: 'KTM Macina Kapoho Master 2024',
  nameKey: 'kapoho macina master',
  specs: { modelYear: 2024, batteryCapacity: 750 },
};

function candidateOf(
  productId: string,
  overrides: Partial<ProductCandidate> = {},
): ProductCandidate {
  return {
    productId,
    displayName: 'KTM Macina Kapoho Master',
    score: 70,
    matchedOn: 'name',
    matchedValue: 'kapoho macina master',
    nameSimilarity: { trigram: 1, levenshtein: 1 },
    failedGates: [],
    ...overrides,
  };
}

describe('ListingMatchLlmService', () => {
  let aiChatService: { createChat: jest.Mock };
  let service: ListingMatchLlmService;

  const respondWith = (body: unknown) =>
    aiChatService.createChat.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify(body) } }],
    });

  const pickOf = (candidateId: string, confidence: number) => ({
    candidateId,
    confidence,
    reason: 'same battery and motor',
  });

  beforeEach(() => {
    aiChatService = { createChat: jest.fn() };
    service = new ListingMatchLlmService(aiChatService as never);
  });

  it('maps the short id back to its product and attaches at the accept confidence', async () => {
    respondWith({ picks: [pickOf('c2', 80)], evidenceSummary: 'summary' });

    await expect(
      service.pick(QUERY, [candidateOf(FIRST_ID), candidateOf(SECOND_ID)]),
    ).resolves.toEqual({
      productId: SECOND_ID,
      confidence: 80,
      reason: 'same battery and motor',
    });
  });

  it('declines one point below the bar, keeping what the LLM said', async () => {
    respondWith({ picks: [pickOf('c1', 79)], evidenceSummary: 'summary' });

    await expect(
      service.pick(QUERY, [candidateOf(FIRST_ID)]),
    ).resolves.toEqual({ confidence: 79, reason: 'same battery and motor' });
  });

  it('ignores a candidate id it never offered', async () => {
    respondWith({ picks: [pickOf('c9', 95)], evidenceSummary: 'nothing fits' });

    await expect(
      service.pick(QUERY, [candidateOf(FIRST_ID)]),
    ).resolves.toEqual({ reason: 'nothing fits' });
  });

  it('takes only the most confident pick when the LLM returns more than one', async () => {
    respondWith({
      picks: [pickOf('c1', 82), pickOf('c2', 91)],
      evidenceSummary: 'summary',
    });

    await expect(
      service.pick(QUERY, [candidateOf(FIRST_ID), candidateOf(SECOND_ID)]),
    ).resolves.toEqual(
      expect.objectContaining({ productId: SECOND_ID, confidence: 91 }),
    );
  });

  it('declines and records the failure when the call errors', async () => {
    aiChatService.createChat.mockRejectedValue(new Error('provider down'));

    await expect(
      service.pick(QUERY, [candidateOf(FIRST_ID)]),
    ).resolves.toEqual({ error: 'provider down' });
  });

  it('shows each candidate with its score and contradictions', async () => {
    respondWith({ picks: [], evidenceSummary: 'summary' });

    await service.pick(QUERY, [
      candidateOf(FIRST_ID, {
        score: 70,
        specs: { batteryCapacity: 750 },
        failedGates: [
          {
            gate: 'primarySpecMismatch',
            spec: 'modelYear',
            severity: 30,
            queryValue: 2024,
            candidateValue: 2023,
          },
        ],
      }),
      candidateOf(SECOND_ID, { score: 74 }),
    ]);

    const [request] = aiChatService.createChat.mock.calls[0];
    expect(request).toEqual(
      expect.objectContaining({
        costLabel: 'listing-match',
        schemaName: 'listing_match_decision',
      }),
    );
    const userMessage = request.messages[1].content;
    expect(userMessage).toContain('Matched on name key: "kapoho macina master"');
    expect(userMessage).toContain(
      'id=c1: KTM Macina Kapoho Master | batteryCapacity=750 | score 70 | -30 modelYear: 2024 vs 2023',
    );
    expect(userMessage).toContain('id=c2');
    expect(userMessage).toContain('no contradictions found');
    expect(userMessage).not.toContain(FIRST_ID);
  });
});
