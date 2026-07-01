import { ThunderConfigSchema, type ThunderConfig } from './schema';

export function defaultThunderConfig(): ThunderConfig {
  return ThunderConfigSchema.parse({});
}
