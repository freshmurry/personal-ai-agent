//queue/worker.ts

// REQUIRED fetch handler (Cloudflare validation)
export default {
  fetch() {
    // This is required for validation but never used
    return new Response("Queue worker alive", { status: 200 })
  },

  async queue(batch: {
    messages: {
      body: unknown
      ack(): void
    }[]
  }) {
    for (const msg of batch.messages) {
      console.log("processing task:", msg.body)
      msg.ack()
    }
  },
}