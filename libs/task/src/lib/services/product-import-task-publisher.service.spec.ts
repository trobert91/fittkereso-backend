import { ProductImportTaskPublisherService } from './product-import-task-publisher.service';
import {
  ProductSource,
  ProductImportTaskKind,
  TaskStatus,
} from '@fittkereso-backend/database';

describe('ProductImportTaskPublisherService', () => {
  let service: ProductImportTaskPublisherService;
  let taskRepo: { save: jest.Mock; saveAll: jest.Mock; findExistingUrl: jest.Mock };
  let sourceRecordRepo: { findBySourceAndUrl: jest.Mock };

  const source = { id: 'source-1', name: 'speedbike' } as ProductSource;

  beforeEach(() => {
    taskRepo = {
      save: jest.fn().mockImplementation((task) => Promise.resolve(task)),
      saveAll: jest.fn().mockImplementation((tasks) => Promise.resolve(tasks)),
      findExistingUrl: jest.fn().mockResolvedValue(null),
    };
    sourceRecordRepo = {
      findBySourceAndUrl: jest.fn().mockResolvedValue(null),
    };

    service = new ProductImportTaskPublisherService(
      taskRepo as any,
      sourceRecordRepo as any,
    );
  });

  describe('addTask', () => {
    it('sets status to PENDING and saves', async () => {
      const task = { url: 'https://speedbike.hu/product/1' } as any;

      await service.addTask(task);

      expect(task.status).toBe(TaskStatus.PENDING);
      expect(taskRepo.save).toHaveBeenCalledWith(task);
    });
  });

  describe('dispatchIfNeeded', () => {
    const baseParams = {
      url: 'https://speedbike.hu/product/1-red/',
      source,
      kind: ProductImportTaskKind.DetailPage,
      processedSince: new Date('2026-08-19T00:00:00Z'),
    };

    it('creates and publishes a new task when the URL is clear', async () => {
      const outcome = await service.dispatchIfNeeded(baseParams);

      expect(outcome.dispatched).toBe(true);
      expect(taskRepo.save).toHaveBeenCalledTimes(1);
      const [savedTask] = taskRepo.save.mock.calls[0];
      expect(savedTask.url).toBe('https://speedbike.hu/product/1-red');
      expect(savedTask.kind).toBe(ProductImportTaskKind.DetailPage);
      expect(savedTask.source).toBe(source);
      expect(savedTask.status).toBe(TaskStatus.PENDING);
      expect(savedTask.product).toBeUndefined();
    });

    it("dispatches at the dispatching task's priority, or a run's default", async () => {
      await service.dispatchIfNeeded({ ...baseParams, priority: 90 });
      await service.dispatchIfNeeded({ ...baseParams, url: 'https://speedbike.hu/product/2' });

      expect(taskRepo.save.mock.calls[0][0].priority).toBe(90);
      expect(taskRepo.save.mock.calls[1][0].priority).toBe(50);
    });

    it('skips dispatch when a pending task already exists for the URL', async () => {
      taskRepo.findExistingUrl.mockResolvedValueOnce({ id: 'existing-task' });

      const outcome = await service.dispatchIfNeeded(baseParams);

      expect(outcome).toEqual({ dispatched: false, reason: 'pending_task' });
      expect(taskRepo.save).not.toHaveBeenCalled();
      expect(sourceRecordRepo.findBySourceAndUrl).not.toHaveBeenCalled();
    });

    it('skips dispatch on a pending task regardless of how far in the future processedSince is', async () => {
      taskRepo.findExistingUrl.mockResolvedValueOnce({ id: 'existing-task' });
      const farFutureCutoff = new Date('2099-01-01T00:00:00Z');

      const outcome = await service.dispatchIfNeeded({
        ...baseParams,
        processedSince: farFutureCutoff,
      });

      expect(outcome).toEqual({ dispatched: false, reason: 'pending_task' });
      expect(sourceRecordRepo.findBySourceAndUrl).not.toHaveBeenCalled();
    });

    it('skips dispatch when a ProductSourceRecord was already updated at/after processedSince', async () => {
      sourceRecordRepo.findBySourceAndUrl.mockResolvedValueOnce({
        updatedAt: new Date('2026-08-20T00:00:00Z'),
      });

      const outcome = await service.dispatchIfNeeded(baseParams);

      expect(outcome).toEqual({ dispatched: false, reason: 'recently_processed' });
      expect(taskRepo.save).not.toHaveBeenCalled();
    });

    it('dispatches when the existing ProductSourceRecord predates processedSince', async () => {
      sourceRecordRepo.findBySourceAndUrl.mockResolvedValueOnce({
        updatedAt: new Date('2026-08-01T00:00:00Z'),
      });

      const outcome = await service.dispatchIfNeeded(baseParams);

      expect(outcome.dispatched).toBe(true);
      expect(taskRepo.save).toHaveBeenCalledTimes(1);
    });
  });
});
