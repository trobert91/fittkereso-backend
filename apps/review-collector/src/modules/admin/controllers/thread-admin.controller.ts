import { Controller } from '@nestjs/common';
import { Get, Param } from '@nestjs/common';

import { ThreadAdminService } from '../services/thread-admin.service';

@Controller('admin-thread')
export class ThreadAdminController {
  constructor(private readonly threadAdminService: ThreadAdminService) {}

  @Get(':id')
  async getThreadById(@Param('id') id: string) {
    return this.threadAdminService.getThreadById(id);
  }
}
