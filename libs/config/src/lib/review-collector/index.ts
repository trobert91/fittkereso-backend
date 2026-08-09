// Pipeline configuration — single source of truth from libs/config/src/lib/configs/
import processorConfig from '../configs/processor.json';
import schedulingConfig from '../configs/scheduling.json';
import openaiConfig from '../configs/openai.json';
import geminiConfig from '../configs/gemini.json';
import claudeConfig from '../configs/claude.json';
import openrouterConfig from '../configs/openrouter.json';
import deepseekConfig from '../configs/deepseek.json';
import resolutionConfig from '../configs/resolution.json';
import relevanceConfig from '../configs/relevance.json';
import scoringConfig from '../configs/scoring.json';
import ratingConfig from '../configs/rating.json';

export const PROCESSOR_DEFAULTS = processorConfig;
export const SCHEDULING_DEFAULTS = schedulingConfig;
export const OPENAI_DEFAULTS = openaiConfig;
export const GEMINI_DEFAULTS = geminiConfig;
export const CLAUDE_DEFAULTS = claudeConfig;
export const OPENROUTER_DEFAULTS = openrouterConfig;
export const DEEPSEEK_DEFAULTS = deepseekConfig;
export const RESOLUTION_DEFAULTS = resolutionConfig;
export const RELEVANCE_DEFAULTS = relevanceConfig;
export const SCORING_DEFAULTS = scoringConfig;
export const RATING_DEFAULTS = ratingConfig;
