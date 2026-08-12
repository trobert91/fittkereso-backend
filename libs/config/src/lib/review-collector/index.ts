// Pipeline configuration — single source of truth from libs/config/src/lib/configs/
import schedulingConfig from '../configs/scheduling.json';
import openaiConfig from '../configs/openai.json';
import geminiConfig from '../configs/gemini.json';
import claudeConfig from '../configs/claude.json';
import deepseekConfig from '../configs/deepseek.json';
import resolutionConfig from '../configs/resolution.json';

export const SCHEDULING_DEFAULTS = schedulingConfig;
export const OPENAI_DEFAULTS = openaiConfig;
export const GEMINI_DEFAULTS = geminiConfig;
export const CLAUDE_DEFAULTS = claudeConfig;
export const DEEPSEEK_DEFAULTS = deepseekConfig;
export const RESOLUTION_DEFAULTS = resolutionConfig;
