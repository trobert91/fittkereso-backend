import { Injectable } from "@nestjs/common";
import { OpenAiConfigService } from "@ebike-backend/config";
import OpenAI from "openai";

@Injectable()
export class OpenAiClientService {
  private readonly _openAi: OpenAI;

  constructor(private readonly openAiConfigService: OpenAiConfigService) {
    this._openAi = new OpenAI({
      apiKey: this.openAiConfigService.apiKey,
    });
  }

  get openAi(): OpenAI {
    return this._openAi;
  }
}
