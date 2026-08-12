import { Injectable } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import { ClaudeConfigService as AppClaudeConfigService } from '@fittkereso-backend/config';

@Injectable()
export class ClaudeClientService {
  private readonly _client: Anthropic;

  constructor(private readonly claudeConfig: AppClaudeConfigService) {
    this._client = new Anthropic({
      apiKey: this.claudeConfig.apiKey,
    });
  }

  get client(): Anthropic {
    return this._client;
  }
}
