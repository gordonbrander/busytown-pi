import type { AgentProcess, AgentRunEvent } from "./types.ts"

export const mockAgent = (id: string): AgentProcess => {
  const { readable: output, writable: outputWritable } =
    new TransformStream<AgentRunEvent, AgentRunEvent>()
  const outputWriter = outputWritable.getWriter()

  const input = new WritableStream<string>(
    {
      async write(_message, _controller) {
        await outputWriter.write({ type: "agent_start" })
        await outputWriter.write({ type: "turn_start" })
        await outputWriter.write({ type: "text_end", content: "" })
        await outputWriter.write({ type: "turn_end" })
        await outputWriter.write({ type: "agent_end" })
      },
      async close() {
        await outputWriter.close()
      },
    },
    new CountQueuingStrategy({ highWaterMark: 1 }),
  )
  const inputWriter = input.getWriter()

  const send = (_message: string, _abort?: AbortSignal): Promise<void> =>
    inputWriter.write(_message)

  const dispose = (): Promise<void> => inputWriter.close()

  return { id, output, send, dispose }
}
