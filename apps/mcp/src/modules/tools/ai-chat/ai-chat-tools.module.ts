import { Module } from '@nestjs/common';
import { AiModule } from '@fittkereso-backend/ai';
import { McpModule } from '@rekog/mcp-nest';
import { AiChatTools } from './ai-chat.tools';

@Module({
  imports: [AiModule, McpModule.forFeature([AiChatTools], 'fittkereso')],
  providers: [AiChatTools],
})
export class AiChatToolsModule {}
