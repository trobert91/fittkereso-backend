import { Test, TestingModule } from '@nestjs/testing';
import type { AiEmbeddingService } from '@fittkereso-backend/ai';
import { ProductEmbeddingService } from './product-embedding.service';

jest.mock('@fittkereso-backend/ai', () => ({
  AiEmbeddingService: class {},
}));

describe('ProductEmbeddingService', () => {
  let service: ProductEmbeddingService;
  let embedMock: jest.Mock;

  beforeEach(async () => {
    embedMock = jest.fn().mockResolvedValue([0.1, 0.2]);
    const { AiEmbeddingService: MockedEmbeddingService } = jest.requireMock(
      '@fittkereso-backend/ai',
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProductEmbeddingService,
        {
          provide: MockedEmbeddingService,
          useValue: {
            createEmbedding: embedMock,
          } as unknown as AiEmbeddingService,
        },
      ],
    }).compile();

    service = module.get<ProductEmbeddingService>(ProductEmbeddingService);
  });

  it('embeds brand + model + category when all present', async () => {
    await service.createProductEmbedding({
      brand: 'LG',
      model: '34GN850',
      displayName: 'LG UltraGear 34GN850',
      category: 'Monitors',
    });
    expect(embedMock).toHaveBeenCalledWith('LG 34GN850 Monitors');
  });

  it('falls back to displayName when model is missing', async () => {
    await service.createProductEmbedding({
      brand: 'LG',
      model: undefined,
      displayName: 'LG UltraGear 34GN850',
      category: 'Monitors',
    });
    expect(embedMock).toHaveBeenCalledWith('LG LG UltraGear 34GN850 Monitors');
  });

  it('omits category when not provided', async () => {
    await service.createProductEmbedding({
      brand: 'LG',
      model: '34GN850',
      displayName: undefined,
      category: undefined,
    });
    expect(embedMock).toHaveBeenCalledWith('LG 34GN850');
  });

  it('omits brand when not provided', async () => {
    await service.createProductEmbedding({
      brand: undefined,
      model: '34GN850',
      displayName: undefined,
      category: 'Monitors',
    });
    expect(embedMock).toHaveBeenCalledWith('34GN850 Monitors');
  });
});
