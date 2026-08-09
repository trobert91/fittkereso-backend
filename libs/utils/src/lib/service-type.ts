export const isWebserver = () => {
  return process.env['SERVICE_TYPE'] === 'webserver';
};

export const isWorker = () => {
  return process.env['SERVICE_TYPE'] === 'worker';
};

export const isSchedulerWorker = () => {
  return process.env['SERVICE_TYPE'] === 'scheduler-worker';
};
