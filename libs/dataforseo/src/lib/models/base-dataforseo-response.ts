export interface BaseDataForSeoResponse {
  status_code: number;
  status_message: string;
  time: string;
  cost: number;
  version: string;
  task_count?: number;
  task_error?: number;
}
