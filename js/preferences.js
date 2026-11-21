export const SKIP_INTERVALS = [5, 10, 15, 30, 60];
const DEFAULT_SKIP_SECONDS = 15;

export function skipInterval(value) {
  const seconds = Number(value);
  return SKIP_INTERVALS.includes(seconds) ? seconds : DEFAULT_SKIP_SECONDS;
}
