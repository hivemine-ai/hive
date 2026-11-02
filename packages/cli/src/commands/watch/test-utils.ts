/** Returns the `code` of the error `fn` throws, or undefined when it does not throw. */
export function thrownCode(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    return (err as { code?: string }).code;
  }
  return undefined;
}
