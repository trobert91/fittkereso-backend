import {
  ProductSourceActor,
  ProductSourceConfig,
  ProductSourceType,
} from '@fittkereso-backend/database';

export interface ProductSourceUpdateParams {
  /** Create-only — supplying a different value is rejected. Present so the
   *  rejection is explicit rather than a silent no-op. */
  type?: ProductSourceType;
  name?: string;
  sellerId?: string;
  config?: ProductSourceConfig;
  /** Note recorded on the version a `config` change creates. Ignored otherwise. */
  configNote?: string;
  schedulingEnabled?: boolean;
  processingEnabled?: boolean;
  priority?: number;
  maxConcurrent?: number;
  requestsPerHour?: number;
  frequency?: string | null;
  nextRunAt?: string | null;
  /**
   * Who is making this change, for the history rows it writes.
   *
   * Resolved by the caller — the controller from @CurrentUser, an MCP tool or
   * a script as a system actor — rather than read out of a request in here, so
   * nothing in a request body can claim to be somebody else.
   */
  actor?: ProductSourceActor;
}
