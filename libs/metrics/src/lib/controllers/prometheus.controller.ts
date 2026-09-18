import { Controller, Get, Res } from '@nestjs/common';
import { Public } from '@fittkereso-backend/utils';
import { Response } from 'express';
import { PrometheusService } from '../prometheus.service';

@Controller('metrics')
@Public()
export class PrometheusController {
  constructor(private readonly prometheusService: PrometheusService) {}

  @Get()
  async getMetrics(@Res() res: Response) {
    const metrics = await this.prometheusService.getMetrics();
    res.setHeader('Content-Type', 'text/plain');
    res.send(metrics);
  }
}
