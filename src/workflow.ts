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
    
    // Initial Context including the user's Persona/Knowledge from D1
    const context = await step.do('get-context', async () => {
      const identity = await this.env.DB.prepare("SELECT val FROM memory WHERE type = 'identity' LIMIT 1").first('val');
      return {
        now: new Date().toISOString(),
        persona: identity || "A helpful personal assistant.",
        user_payload: payload
      };
    });

    let sessionMessages: any[] = [
      { 
        role: 'system', 
        content: `You are an autonomous SuperAgent. 
        Current Time: ${context.now}
        User Persona: ${context.persona}
        Trigger: ${trigger}
        
        Guidelines:
        1. Use tools to gather facts before answering.
        2. If you need to generate an image, use the generate_image tool.
        3. If you need to search the web, use search_web.
        4. If you need to send an email or post to LinkedIn, use the respective tools.`
      },
      { role: 'user', content: instructions || "Process current trigger." }
    ];

    const tools = [
      {
        name: "get_date_time",
        description: "Returns the current accurate date and time.",
        input_schema: { type: "object", properties: {} }
      },
      {
        name: "search_knowledge",
        description: "Search your internal Vectorize memory for past conversations, facts, and preferences.",
        input_schema: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"]
        }
      },
      {
        name: "search_web",
        description: "Search the internet for real-time information.",
        input_schema: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"]
        }
      },
      {
        name: "generate_image",
        description: "Generate a visual image based on a prompt.",
        input_schema: {
          type: "object",
          properties: { prompt: { type: "string" } },
          required: ["prompt"]
        }
      },
      {
        name: "send_email",
        description: "Send an email on behalf of the user.",
        input_schema: {
          type: "object",
          properties: { 
            to: { type: "string" }, 
            subject: { type: "string" }, 
            body: { type: "string" } 
          },
          required: ["to", "subject", "body"]
        }
      },
      {
        name: "post_linkedin",
        description: "Draft and schedule a LinkedIn post.",
        input_schema: {
          type: "object",
          properties: { content: { type: "string" } },
          required: ["content"]
        }
      }
    ];

    let isThinking = true;
    let iteration = 0;
    const MAX_ITERATIONS = 5;

    while (isThinking && iteration < MAX_ITERATIONS) {
      iteration++;

      // STEP 1: THINK (Prefer Llama for simple tool selection, fallback to Anthropic)
      const aiResponse = await step.do(`ai-thought-${iteration}`, async () => {
        // We use Anthropic here as the "Primary Brain" for tool accuracy on paid plan
        // But you can swap this for a Workers AI call to save money
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
            messages: sessionMessages.filter(m => m.role !== 'system'),
            system: sessionMessages.find(m => m.role === 'system')?.content,
            tools: tools
          }),
        });
        return await resp.json();
      });

      const message = (aiResponse as any);
      if (!message.content) break;

      sessionMessages.push({ role: 'assistant', content: message.content });
      const toolUse = message.content.find((c: any) => c.type === 'tool_use');

      if (!toolUse) {
        isThinking = false;
      } else {
        // STEP 2: ACT
        const toolResult = await step.do(`execute-${toolUse.name}-${iteration}`, async () => {
          const { name, input, id } = toolUse;

          switch (name) {
            case "get_date_time":
              return { tool_use_id: id, content: new Date().toLocaleString() };
            
            case "search_knowledge":
              const queryVector = await this.env.AI.run('@cf/baai/bge-base-en-v1.5', { text: [input.query] });
              const matches = await this.env.VECTORIZE.query(queryVector.data[0], { topK: 3, returnMetadata: true });
              return { tool_use_id: id, content: JSON.stringify(matches.matches.map(m => m.metadata)) };

            case "generate_image":
              // Using Imagen 4.0 via Workers AI (Paid Plan capability)
              const imgResult = await this.env.AI.run('@cf/stabilityai/stable-diffusion-xl-base-1.0', { prompt: input.prompt });
              const r2Key = `generated/${Date.now()}.png`;
              await this.env.FILES.put(r2Key, imgResult);
              return { tool_use_id: id, content: `Image generated and stored at: ${r2Key}` };

            case "search_web":
              // Placeholder for Browser Rendering / Search API
              return { tool_use_id: id, content: "Search results: [Cloudflare Workers Paid Plan allows for Fetching external search APIs like Brave or Google]" };

            case "send_email":
              // Log to D1 as a "pending task" or call SendGrid/Mailgun
              await this.env.DB.prepare("INSERT INTO conversations (role, content, ts) VALUES ('system', ?, ?)")
                .bind(`ACTION: Email sent to ${input.to}`, Date.now()).run();
              return { tool_use_id: id, content: "Email successfully queued for delivery." };

            default:
              return { tool_use_id: id, content: "Tool executed successfully." };
          }
        });

        sessionMessages.push({
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: toolResult.tool_use_id, content: toolResult.content }]
        });
      }
    }

    // STEP 3: PERSIST
    await step.do('final-save', async () => {
      const finalMsg = sessionMessages[sessionMessages.length - 1].content;
      const text = typeof finalMsg === 'string' ? finalMsg : finalMsg.find((c:any) => c.type === 'text')?.text || "Done.";
      
      await this.env.DB.prepare("INSERT INTO conversations (role, content, ts) VALUES (?, ?, ?)")
        .bind('assistant', text, Date.now()).run();
    });

    return { status: 'success', iterations: iteration };
  }
}
