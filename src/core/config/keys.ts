export const CONFIG_SECTION = 'thunder';

export function thunderConfigKey(path: string): string {
  return `${CONFIG_SECTION}.${path}`;
}
