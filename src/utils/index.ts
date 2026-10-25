export function parseExpiresIn(value?: string): number | string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  if (/^\d+[smhd]$/.test(trimmed)) return trimmed;
  return trimmed;
}

export function parseExpiresInMs(
  value?: string,
  fallbackMs: number = 7 * 24 * 60 * 60 * 1000,
): number {
  if (!value) return fallbackMs;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed) * 1000;
  }
  const match = /^(\d+)([smhd])$/i.exec(trimmed);
  if (!match) return fallbackMs;

  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  switch (unit) {
    case 's':
      return amount * 1000;
    case 'm':
      return amount * 60 * 1000;
    case 'h':
      return amount * 60 * 60 * 1000;
    case 'd':
      return amount * 24 * 60 * 60 * 1000;
    default:
      return fallbackMs;
  }
}
