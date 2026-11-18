/** Simple sliding-window rate limiter (in-process). */
export class SlidingWindowRateLimiter {
  private readonly hits: number[] = [];

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  tryTake(): boolean {
    const now = Date.now();
    while (this.hits.length && this.hits[0]! <= now - this.windowMs) {
      this.hits.shift();
    }
    if (this.hits.length >= this.limit) return false;
    this.hits.push(now);
    return true;
  }

  reset(): void {
    this.hits.length = 0;
  }
}
