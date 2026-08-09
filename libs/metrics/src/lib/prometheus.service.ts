import { Injectable } from "@nestjs/common";
import * as client from "prom-client";
import { LoggerConfigService } from "@ebike-backend/config";

@Injectable()
export class PrometheusService {
  private readonly _register: client.Registry;
  private readonly processedThreadsCounter: client.Counter<string>;

  constructor(private readonly loggerConfig: LoggerConfigService) {
    this._register = new client.Registry();
    this._register.setDefaultLabels({ app: loggerConfig.appName });
    client.collectDefaultMetrics({ register: this._register });
  }

  getMetrics(): Promise<string> {
    return this._register.metrics();
  }

  get register(): client.Registry {
    return this._register;
  }
}
