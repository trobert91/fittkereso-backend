import { Body, Controller, Post } from '@nestjs/common';
import { ProcessThreadScheduler } from '../../../scheduling/schedulers/process-thread-scheduler';

@Controller('schedule-test')
export class ScheduleTestController {
  constructor(private readonly scheduler: ProcessThreadScheduler) {}

  @Post('process-threads')
  async processThreads(@Body() body: { count: number }): Promise<{ status: string }> {
    await this.scheduler.scheduleWithBudget(body.count);
    return { status: 'done' };
  }
}
