# Web Streams Guide

Web Streams are a WHATWG standard API for processing data incrementally. They're
available in browsers, Node, and Deno.

## The problem streams solve

You have data that arrives over time (network response, file read, user input)
or data too large to hold in memory. Instead of buffering everything into a
string or array, you process it piece by piece.

## The three stream types

### ReadableStream — the source

A source of data you pull from. Produces chunks on demand.

```ts
const readable = new ReadableStream({
  start(controller) {
    // Called once when the stream is created.
    // Use for setup. Avoid producing data here.
  },

  pull(controller) {
    // Called when the consumer wants more data.
    // This is demand-driven — the key to backpressure.
    controller.enqueue("a chunk of data");
  },

  cancel(reason) {
    // Called when the consumer cancels the stream.
    // Clean up resources here.
  },
});
```

### WritableStream — the sink

A terminal that consumes data. Data goes in; it doesn't come out the other side.
The "consumer" is the underlying sink — the `write()` function you provide at
construction time.

```ts
const writable = new WritableStream({
  write(chunk) {
    // Called for each chunk. This IS the consumer.
    // If this returns a promise, the stream waits for it
    // to resolve before processing the next queued chunk.
    console.log("received:", chunk);
  },

  close() {
    // Called when the producer signals it's done.
  },

  abort(reason) {
    // Called on abnormal termination.
  },
});
```

### TransformStream — the pipe fitting

Sits in the middle. Has a writable side (input) and a readable side (output).
Takes chunks in, emits (possibly different) chunks out.

```ts
const transform = new TransformStream({
  transform(chunk, controller) {
    // Process each incoming chunk and enqueue the result.
    controller.enqueue(chunk.toUpperCase());
  },

  flush(controller) {
    // Called when the writable side is closed.
    // Emit any remaining buffered data here.
    controller.enqueue("-- done --");
  },
});
```

## Consuming streams

### Piping — declarative, handles backpressure automatically

```ts
readable.pipeThrough(transform).pipeTo(writable);
```

### Async iteration — pull-based, one chunk at a time

```ts
for await (const chunk of readable) {
  process(chunk);
}
```

### Manual reader

```ts
const reader = readable.getReader();
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  process(value);
}
reader.releaseLock();
```

## Queues and high water marks

Both ReadableStream and WritableStream have their own internal queues.

- **ReadableStream queue:** Buffers chunks the source has produced but the
  consumer hasn't read yet.
- **WritableStream queue:** Buffers chunks that have been written but not yet
  processed by the underlying sink.

The **high water mark** is a soft threshold — a hint that says "you probably have
enough buffered." It is NOT a hard limit. The default is 1 chunk for object
streams, or 16KB for byte streams.

**`desiredSize`** reflects how much room is left before hitting the high water
mark. When it goes to zero or negative, the stream is signaling "slow down."
Nothing enforces this — it's a cooperative protocol.

When you pipe streams together, backpressure flows end-to-end: slow sink
&rarr; writable queue fills &rarr; pauses pulling from readable &rarr; readable
queue fills &rarr; source slows down. Two queues, one chain of signals.

## Backpressure

Backpressure in web streams is a **protocol, not a mechanism.** Both sides have
to participate. The stream gives you the signals; you have to respect them.

### ReadableStream: demand-driven production with `pull()`

The `pull()` callback is only called when the consumer wants more data and the
queue is below the high water mark. By putting production logic in `pull()`
instead of `start()`, you get backpressure for free:

```ts
const stream = new ReadableStream({
  start() {
    this.i = 0;
  },

  pull(controller) {
    // Only called when the consumer is ready for more.
    // No need to check desiredSize yourself.
    controller.enqueue(`chunk ${this.i++}`);

    if (this.i >= 100) {
      controller.close();
    }
  },
});
```

The same pattern works for async sources. `pull()` can return a promise, and
the stream won't call it again until that promise resolves AND the queue needs
more data:

```ts
const stream = new ReadableStream({
  async pull(controller) {
    const data = await fetchNextBatch();
    if (data === null) {
      controller.close();
    } else {
      controller.enqueue(data);
    }
  },
});
```

#### The wrong way: push everything in `start()`

```ts
// BAD: produces everything immediately, ignores backpressure
const stream = new ReadableStream({
  start(controller) {
    for (let i = 0; i < 100; i++) {
      controller.enqueue(`chunk ${i}`); // all queued synchronously
    }
    controller.close();
  },
});
```

This shoves all chunks into the queue during `start()`, before anyone reads
anything. It defeats the purpose of streaming.

### WritableStream: backpressure from the sink

On a WritableStream, backpressure is driven by the sink's speed. When `write()`
returns a promise, the stream waits for it to resolve before calling `write()`
again. While waiting, additional writes from the producer queue up, and
`desiredSize` drops.

The producer cooperates by awaiting the write promise:

```ts
const writer = writable.getWriter();

for (const item of items) {
  // await pauses until the sink catches up
  await writer.write(item);
}

await writer.close();
```

Without `await`, you fire-and-forget every write synchronously, the queue grows
without bound, and memory usage is unbounded:

```ts
// BAD: ignores backpressure, unbounded memory growth
for (const item of hugeArray) {
  writer.write(item); // no await
}
```

The stream never throws or drops data in this case. It just keeps accepting
chunks. `desiredSize` goes negative, but nothing stops you.

### TransformStream: backpressure flows through

A TransformStream connects a writable side to a readable side. Backpressure
propagates from the readable side back through to the writable side.

If nobody is reading from the readable side, chunks produced by the transform
accumulate in the readable's internal queue. Once that queue fills past the high
water mark, the transform stops pulling from the writable side, which causes the
writable queue to fill, which signals the upstream producer to slow down.

```ts
const slow = new TransformStream(
  {
    async transform(chunk, controller) {
      // Simulate slow processing
      await new Promise((r) => setTimeout(r, 100));
      controller.enqueue(chunk.toUpperCase());
    },
  },
  // Writable side strategy (input buffer)
  new CountQueuingStrategy({ highWaterMark: 1 }),
  // Readable side strategy (output buffer)
  new CountQueuingStrategy({ highWaterMark: 1 }),
);
```

With small high water marks, backpressure kicks in quickly — the transform only
processes one chunk at a time, and the producer pauses until the consumer reads
the output.

In a full pipeline:

```ts
source.pipeThrough(decompress).pipeThrough(parse).pipeTo(sink);
```

Backpressure flows right-to-left through the entire chain. If `sink` is slow,
`parse` stalls, which stalls `decompress`, which stalls `source`. Each
transform's readable queue fills up, which prevents its writable side from
accepting more, which propagates the signal upstream.

## Readers, locking, and stream lifetime

### One reader at a time

A ReadableStream can only have one reader at a time. Calling `getReader()` locks
the stream to that reader. Any attempt to get another reader, pipe, or iterate
the stream while locked throws a TypeError:

```ts
const reader1 = stream.getReader();
const reader2 = stream.getReader(); // TypeError: ReadableStream is already locked
```

**Why?** A stream is a sequential, one-time data source. Chunks are consumed —
once read, they're gone from the queue. If two readers pulled simultaneously,
you'd get interleaved, unpredictable partial reads. The lock prevents that.

### Releasing a lock

`reader.releaseLock()` gives up the lock without canceling the stream. The
stream stays alive with its remaining queued chunks. A new reader picks up where
the previous one left off:

```ts
const reader1 = stream.getReader();
const { value: v1 } = await reader1.read(); // reads chunk 0
reader1.releaseLock();

const reader2 = stream.getReader();
const { value: v2 } = await reader2.read(); // reads chunk 1
```

### Canceling vs. releasing

These are different operations:

- **`reader.releaseLock()`** — gives up the lock. Stream stays alive.
- **`reader.cancel()`** — cancels the underlying source. The stream is done.
  This calls the source's `cancel()` callback and the stream cannot produce more
  data.

### `tee()` for multiple consumers

If you need two consumers to each receive every chunk, use `tee()`:

```ts
const [branch1, branch2] = stream.tee();
```

Under the hood, `tee()` buffers: if one branch reads faster, chunks accumulate
until the slower branch catches up. Memory cost is proportional to how far apart
the two consumers get. It also partially undermines backpressure — the source
can't slow down just because one branch is slow if the other is still reading
fast.

### `pipeTo` and stream lifetime

By default, `pipeTo` ties the lifetime of the readable to the writable. When the
writable closes, the readable is canceled. When the readable ends, the writable
is closed. This is usually what you want for a simple pipeline.

`pipeTo` returns a promise that resolves when the pipe finishes — meaning it
blocks until the destination stream closes (or errors):

```ts
// This awaits until writable closes
await readable.pipeTo(writable);
// readable is now canceled — it's dead
```

### `preventCancel`: keeping the source alive

Pass `preventCancel: true` to `pipeTo` to prevent the readable from being
canceled when the writable closes:

```ts
await readable.pipeTo(writable1, { preventCancel: true });
// writable1 closed, but readable is still alive and unlocked
```

This lets you pipe the same readable to a second destination, picking up where
the first left off:

```ts
await readable.pipeTo(writable1, { preventCancel: true });
await readable.pipeTo(writable2, { preventCancel: true });
```

Because each `pipeTo` is awaited, this is sequential: all chunks go to
`writable1` until it closes, then all subsequent chunks go to `writable2`. The
two pipes never run concurrently — the readable is locked while a pipe is active.
If `writable1` never closes, you never reach the second pipe.

This is useful for rotating output destinations (e.g., log file rotation,
switching network connections) without restarting the source.

There are also `preventClose` and `preventAbort` options for controlling the
other direction — whether closing or aborting the readable affects the writable.

### Wrapping a stream to decouple lifetime

If you want to hand out a "sub-stream" that consumers can close or cancel
freely without affecting the upstream source:

```ts
const makeDetachedReadable = (source: ReadableStream): ReadableStream => {
  const reader = source.getReader();
  return new ReadableStream({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
      } else {
        controller.enqueue(value);
      }
    },
    cancel() {
      // Release the lock but do NOT cancel the source
      reader.releaseLock();
    },
  });
};
```

The consumer can cancel this wrapper stream freely — it just releases the lock
on the original. The upstream source keeps running and a new reader (or wrapper)
can pick up later.

## Summary

| Concept                  | Key point                                                           |
| ------------------------ | ------------------------------------------------------------------- |
| `pull()`                 | Demand-driven. Use this for production — backpressure is automatic. |
| `start()`                | For setup only. Don't produce data here.                            |
| High water mark          | Soft threshold, not a hard limit.                                   |
| `desiredSize`            | Signal, not enforcement. Both sides must cooperate.                 |
| `await writer.write()`   | How producers respect backpressure on the writable side.            |
| `pipeThrough` / `pipeTo` | Connects streams and propagates backpressure automatically.         |
