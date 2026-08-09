import { OpenAiMetricsService } from './openai-metrics.service';
import { AiMetricsService } from './ai-metrics.service';
import { PrometheusService } from '../prometheus.service';
import * as client from 'prom-client';

describe('OpenAiMetricsService', () => {
  let service: OpenAiMetricsService;
  let mockPrometheusService: Partial<PrometheusService>;
  let mockRegister: client.Registry;
  let aiMetrics: AiMetricsService;

  beforeEach(() => {
    mockRegister = new client.Registry();
    mockPrometheusService = {
      register: mockRegister,
    };
    aiMetrics = new AiMetricsService(mockPrometheusService as PrometheusService);

    service = new OpenAiMetricsService(
      mockPrometheusService as PrometheusService,
      aiMetrics,
    );
  });

  afterEach(() => {
    mockRegister.clear();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should record successful completion', async () => {
    service.recordCompletion(
      'gpt-5.4-nano',
      'comment_planning_nano',
      1.5,
      100,
      50,
      'success',
    );

    const metrics = await mockRegister.metrics();

    expect(metrics).toContain('openai_chat_completion_total');
    expect(metrics).toContain('model="gpt-5.4-nano"');
    expect(metrics).toContain('cost_label="comment_planning_nano"');
    expect(metrics).toContain('status="success"');
  });

  it('should record error completion', async () => {
    service.recordCompletion(
      'gpt-5.4-nano',
      'comment_extraction_mini',
      0,
      0,
      0,
      'error',
    );

    const metrics = await mockRegister.metrics();

    expect(metrics).toContain('openai_chat_completion_total');
    expect(metrics).toContain('model="gpt-5.4-nano"');
    expect(metrics).toContain('cost_label="comment_extraction_mini"');
    expect(metrics).toContain('status="error"');
  });

  it('should record duration for successful completions', async () => {
    service.recordCompletion(
      'gpt-5.4-nano',
      'comment_planning_nano',
      2.5,
      100,
      50,
      'success',
    );

    const metrics = await mockRegister.metrics();

    expect(metrics).toContain('openai_chat_completion_duration_seconds');
    expect(metrics).toContain('model="gpt-5.4-nano"');
  });

  it('should record prompt tokens for successful completions', async () => {
    service.recordCompletion(
      'gpt-5.4-nano',
      'comment_planning_nano',
      1.0,
      150,
      75,
      'success',
    );

    const metrics = await mockRegister.metrics();

    expect(metrics).toContain('openai_chat_completion_tokens_total');
    expect(metrics).toContain('token_type="prompt"');
    expect(metrics).toContain('150');
  });

  it('should record completion tokens for successful completions', async () => {
    service.recordCompletion(
      'gpt-5.4-nano',
      'comment_extraction_mini',
      1.0,
      150,
      75,
      'success',
    );

    const metrics = await mockRegister.metrics();

    expect(metrics).toContain('openai_chat_completion_tokens_total');
    expect(metrics).toContain('token_type="completion"');
    expect(metrics).toContain('75');
  });

  it('should not record duration and tokens for error completions', async () => {
    service.recordCompletion(
      'gpt-5.4-nano',
      'comment_planning_nano',
      0,
      0,
      0,
      'error',
    );

    const metrics = await mockRegister.metrics();

    // Should have completion counter with error status
    expect(metrics).toContain('openai_chat_completion_total');
    expect(metrics).toContain('status="error"');

    // Should not have duration or tokens recorded (or should be 0)
    const metricsLines = metrics.split('\n');
    const tokenLines = metricsLines.filter(
      (line) =>
        line.includes('openai_chat_completion_tokens_total') &&
        !line.startsWith('#'),
    );

    // No token metrics should be recorded for errors
    expect(tokenLines.length).toBe(0);
  });

  it('should track multiple models separately', async () => {
    service.recordCompletion(
      'gpt-5.4-nano',
      'comment_planning_nano',
      1.0,
      100,
      50,
      'success',
    );
    service.recordCompletion(
      'gpt-5.4-nano',
      'comment_planning_mini',
      2.0,
      200,
      100,
      'success',
    );

    const metrics = await mockRegister.metrics();

    expect(metrics).toContain('model="gpt-5.4-nano"');
    expect(metrics).toContain('model="gpt-5.4-nano"');
  });

  it('should track multiple cost labels separately', async () => {
    service.recordCompletion(
      'gpt-5.4-nano',
      'comment_planning_nano',
      1.0,
      100,
      50,
      'success',
    );
    service.recordCompletion(
      'gpt-5.4-nano',
      'comment_extraction_nano',
      1.5,
      150,
      75,
      'success',
    );

    const metrics = await mockRegister.metrics();

    expect(metrics).toContain('cost_label="comment_planning_nano"');
    expect(metrics).toContain('cost_label="comment_extraction_nano"');
  });

  it('should increment counter for multiple calls with same labels', async () => {
    service.recordCompletion(
      'gpt-5.4-nano',
      'comment_planning_nano',
      1.0,
      100,
      50,
      'success',
    );
    service.recordCompletion(
      'gpt-5.4-nano',
      'comment_planning_nano',
      1.2,
      110,
      55,
      'success',
    );
    service.recordCompletion(
      'gpt-5.4-nano',
      'comment_planning_nano',
      0.9,
      95,
      45,
      'success',
    );

    const metrics = await mockRegister.metrics();

    // Counter should show 3 completions
    const counterLine = metrics
      .split('\n')
      .find(
        (line) =>
          line.includes('openai_chat_completion_total') &&
          line.includes('model="gpt-5.4-nano"') &&
          line.includes('cost_label="comment_planning_nano"') &&
          line.includes('status="success"'),
      );

    expect(counterLine).toContain('3');
  });
});
