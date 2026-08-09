import { Test, TestingModule } from "@nestjs/testing";
import { QueuePublisherService } from "@ebike-backend/task";
import { QueueTestController } from "./queue-test.controller";

describe("QueueTestController", () => {
  let controller: QueueTestController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [QueueTestController],
      providers: [
        {
          provide: QueuePublisherService,
          useValue: { addThreadProcessTask: jest.fn() },
        },
      ],
    }).compile();

    controller = module.get<QueueTestController>(QueueTestController);
  });

  it("should be defined", () => {
    expect(controller).toBeDefined();
  });
});
