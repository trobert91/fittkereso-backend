import { HttpService } from "@nestjs/axios";
import { AxiosRequestConfig } from "axios";
import { BaseDataForSeoResponse } from "../models/base-dataforseo-response";
import { DataForSeoConfigService } from "@ebike-backend/config";
import { CustomLogger } from "@ebike-backend/logger";

export abstract class BaseDataForSeoService {
  constructor(
    protected httpService: HttpService,
    protected config: DataForSeoConfigService,
  ) {}

  protected async get<T extends BaseDataForSeoResponse>(url: string) {
    const response = await this.httpService.axiosRef.get<T>(
      url,
      this.getDataForSeoConfig(),
    );

    if (response.status === 402) {
      this.getLogger().error(
        "Dataforseo request failed with status 402, insufficient funds",
      );
    }

    return response;
  }

  protected async post<T extends BaseDataForSeoResponse>(
    url: string,
    data?: any,
  ) {
    const response = await this.httpService.axiosRef.post<T>(
      url,
      data,
      this.getDataForSeoConfig(),
    );

    if (response.status === 402) {
      this.getLogger().error(
        "Dataforseo request failed with status 402, insufficient funds",
      );
    }

    return response;
  }

  protected getDataForSeoConfig() {
    const basicAuth = Buffer.from(
      `${this.config.email}:${this.config.password}`,
    ).toString("base64");

    const config: AxiosRequestConfig = {
      baseURL: this.config.apiUrl,
      headers: {
        Authorization: `Basic ${basicAuth}`,
      },
    };

    return config;
  }

  protected abstract getLogger(): CustomLogger;
}
