export function parseExpiresIn(value?: string): number | string | undefined {
  if (!value) return undefined;
  if (/^\d+$/.test(value)) return Number(value);
  if (/^\d+[smhd]$/.test(value)) return value;
}
