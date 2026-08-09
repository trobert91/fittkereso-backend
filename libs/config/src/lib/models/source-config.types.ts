import { z } from 'zod';

const sourceCategoryConfigSchema = z.object({
  enabled: z.boolean().default(true),
  sourceTitle: z.string().optional(),
});

const productSourceIncrementalSyncConfigSchema = z.object({
  searchKeywords: z.array(z.string()).optional(),
  numResults: z.number().int().positive().optional(),
});

export const productSourceFileConfigSchema = z.object({
  baseUrl: z.string().url(),
  fullSyncStartUrl: z.string().url().optional(),
  categories: z.record(z.string(), sourceCategoryConfigSchema).optional(),
  incrementalSync: productSourceIncrementalSyncConfigSchema.optional(),
});

export type ProductSourceFileConfig = z.infer<typeof productSourceFileConfigSchema>;
export type SourceCategoryConfig = z.infer<typeof sourceCategoryConfigSchema>;
export type ProductSourceIncrementalSyncConfig = z.infer<typeof productSourceIncrementalSyncConfigSchema>;
