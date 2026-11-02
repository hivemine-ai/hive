// The SDK client hides SSE comment frames, so a keep-alive never reaches it.
// This wrapper taps the raw response body and reports every chunk of bytes, which
// is what the silence detector measures.

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export function livenessFetch(base: FetchLike, onBytes: () => void): FetchLike {
  return async (input, init) => {
    const res = await base(input, init);
    const type = res.headers.get('content-type') ?? '';
    if (!res.body || !type.startsWith('text/event-stream')) return res;
    const tap = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        onBytes();
        controller.enqueue(chunk);
      },
    });
    return new Response(res.body.pipeThrough(tap), {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
  };
}
