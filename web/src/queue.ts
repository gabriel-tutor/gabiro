/** Runs async jobs strictly one at a time, in the order they were queued. A failing job doesn't stop the next. */
export function createQueue() {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    run<T>(job: () => Promise<T>): Promise<T> {
      const result = tail.then(job);
      tail = result.catch(() => undefined);
      return result;
    },
  };
}
