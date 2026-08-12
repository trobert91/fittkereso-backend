import { Injectable } from '@nestjs/common';
import { GoogleGenAI } from '@google/genai';
import { GeminiConfigService as AppGeminiConfigService } from '@fittkereso-backend/config';

@Injectable()
export class GeminiClientService {
  private readonly _client: GoogleGenAI;

  constructor(private readonly geminiConfig: AppGeminiConfigService) {
    this._client = new GoogleGenAI({
      apiKey: this.geminiConfig.apiKey,
    });
  }

  get client(): GoogleGenAI {
    return this._client;
  }
}
