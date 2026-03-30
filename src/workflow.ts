import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from 'cloudflare:workers';

interface Params {
  trigger: string;
  instructions?: string;
  payload?: any;
  notify?: string;
}

export class AutomationWorkflow extends WorkflowEntrypoint<{ 
  DB: D1Database, 
  VECTORIZE: VectorizeIndex, 
  FILES: R2Bucket,
  AI: any,
  ANTHROPIC_API_KEY: string 
}, Params> {
  
  async run(event: WorkflowEvent<Params>, step: WorkflowStep) {
    const { trigger, instructions, payload } = event.payload;
    
    // The Agent's working memory for the duration of the workflow
    let sessionMessages: any[] = [
      { 
        role: 'user', 
        content: `System Trigger: ${trigger}\nContext: ${JSON.stringify(payload)}\nTask: ${instructions}\n\nYou are an autonomous agent. Use your tools to gather information before answering if needed.` 
      }
    ];

    // Define the tools available to the Agent
    const tools = [
      {
        name: "search_memory",
        description: "Search long-term semantic memory for facts, preferences, or past project details.",
        input_schema: {
          type: "object",
          properties: {
            query: { type: "string", description: "The search term or question." }
          },
          required: ["query"]
        }
      },
      {
        name: "list_files",
        description: "List all files currently stored in your R2 bucket.",
        input_schema: { type: "object", properties: {} }
      },
      {
        name: "query_database",
        description: "Run a simple SELECT query on the conversations history table.",
        input_schema: {
          type: "object",
          properties: {
            limit: { type: "number", default: 5 }
          }
        }
      }
    ];

    let isThinking = true;
    let iteration = 0;
    const MAX_ITERATIONS = 5;

    while (isThinking && iteration < MAX_ITERATIONS) {
      iteration++;

      // 1. AI "THINK" STEP
      const aiResponse = await step.do(`ai-thought-${iteration}`, async () => {
        const resp = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': this.env.ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: 'claude-3-5-sonnet-latest',
            max_tokens: 1024,
            messages: sessionMessages,
            tools: tools
          }),
        });
        return await resp.json();
      });

      const message = (aiResponse as any);
      sessionMessages.push({ role: 'assistant', content: message.content });

      // Check if Claude wants to use a tool
      const toolUse = message.content.find((c: any) => c.type === 'tool_use');

      if (!toolUse) {
        isThinking = false; // Final answer reached
      } else {
        // 2. "ACT" STEP - Execute the requested tool
        const toolResult = await step.do(`execute-tool-${iteration}`, async () => {
          const { name, input, id } = toolUse;

          if (name === "search_memory") {
            const embedding = await this.env.AI.run('@cf/baai/bge-base-en-v1.5', { text: [input.query] });
            const vectors = await this.env.VECTORIZE.query(embedding.data[0], { topK: 3, returnMetadata: true });
            return { tool_use_id: id, content: JSON.stringify(vectors.matches.map(m => m.metadata)) };
          }

          if (name === "list_files") {
            const { results } = await this.env.DB.prepare("SELECT name, size FROM files LIMIT 10").all();
            return { tool_use_id: id, content: JSON.stringify(results) };
          }

          if (name === "query_database") {
            const { results } = await this.env.DB.prepare("SELECT content FROM conversations ORDER BY ts DESC LIMIT ?").bind(input.limit || 5).all();
            return { tool_use_id: id, content: JSON.stringify(results) };
          }

          return { tool_use_id: id, content: "Error: Tool not found" };
        });

        // 3. "OBSERVE" - Feed result back to AI
        sessionMessages.push({
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: toolResult.tool_use_id,
            content: toolResult.content
          }]
        });
      }
    }

    // 4. PERSIST FINAL RESULT
    await step.do('persist-final-response', async () => {
      const finalContent = sessionMessages[sessionMessages.length - 1].content;
      const textResponse = typeof finalContent === 'string' 
        ? finalContent 
        : finalContent.find((c: any) => c.type === 'text')?.text || "Task processed.";

      await this.env.DB.prepare(
        "INSERT INTO conversations (role, content, ts) VALUES (?, ?, ?)"
      ).bind('assistant', `[Agentic Workflow] ${textResponse}`, Date.now()).run();
    });

    return { status: 'completed', message_count: sessionMessages.length };
  }
}
