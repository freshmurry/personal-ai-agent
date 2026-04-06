import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from 'cloudflare:workers';
import { Connectors } from './connectors';
import { BrowserTool } from './tools/browser';

interface Params {
  trigger: string;
  instructions?: string;
  payload?: any;
  notify?: string;
  persona?: string; // Injected by index.ts Memory Service
}

export class AutomationWorkflow extends WorkflowEntrypoint<{ 
  DB: D1Database, 
  VECTORIZE: VectorizeIndex, 
  FILES: R2Bucket,
  AI: any,
  ANTHROPIC_API_KEY: string,
  BRAVE_API_KEY: string,
  LINKEDIN_CLIENT_ID: string,
  LINKEDIN_CLIENT_SECRET: string
}, Params> {
  
  async run(event: WorkflowEvent<Params>, step: WorkflowStep) {
    const { trigger, instructions, payload, persona } = event.payload;
    const now = new Date().toLocaleString();

    // 1. UX STEP: Immediate "Thinking" status in D1 for the UI/WhatsApp to see
    await step.do('set-initial-status', async () => {
      await this.env.DB.prepare(
        "INSERT INTO conversations (role, content, ts, summary) VALUES ('system', 'Agent is analyzing your request...', ?, 1)"
      ).bind(Date.now()).run();
    });

    // 2. ROUTER: Cheap Llama-3.1-8b Classification
    const route = await step.do('router-logic', async () => {
      const response = await this.env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
        messages: [
          { 
            role: 'system', 
            content: 'Classify as "SIMPLE" (time, greetings) or "COMPLEX" (tools, research, social, email). Return one word.' 
          },
          { role: 'user', content: instructions || "" }
        ]
      });
      return response.response.toUpperCase().includes('COMPLEX') ? 'COMPLEX' : 'SIMPLE';
    });

    if (route === 'SIMPLE') {
      return await step.do('handle-simple', async () => {
        const result = await this.env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
          messages: [
            { role: 'system', content: `Identity: ${persona}. Time: ${now}. Answer briefly.` },
            { role: 'user', content: instructions || "" }
          ]
        });
        await this.env.DB.prepare("INSERT INTO conversations (role, content, ts) VALUES ('assistant', ?, ?)")
          .bind(result.response, Date.now()).run();
        return result.response;
      });
    }

    // 3. DYNAMIC TOOL DEFINITIONS
    const tools = [
      {
        name: "search_knowledge",
        description: "Search internal long-term memory and persona facts.",
        input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] }
      },
      {
        name: "search_web",
        description: "Search the live internet for news and real-time facts.",
        input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] }
      },
      {
        name: "send_email",
        description: "Send a formal email.",
        input_schema: { 
          type: "object", 
          properties: { to: { type: "string" }, subject: { type: "string" }, body: { type: "string" } },
          required: ["to", "subject", "body"]
        }
      },
      {
        name: "post_linkedin",
        description: "Post an update to LinkedIn.",
        input_schema: { type: "object", properties: { content: { type: "string" } }, required: ["content"] }
      }
    ];

    // 4. COMPLEX AGENTIC LOOP (Claude 3.5 Sonnet)
    let sessionMessages: any[] = [
      { role: 'user', content: instructions || "Execute." }
    ];

    const systemPrompt = `You are an Autonomous SuperAgent.
    User Persona: ${persona}
    Time: ${now}
    Trigger: ${trigger}
    Goal: Use tools to fulfill the user request precisely.`;

    let isThinking = true;
    let iteration = 0;
    
    while (isThinking && iteration < 5) {
      iteration++;

      const aiResponse = await step.do(`thought-loop-${iteration}`, async () => {
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
            system: systemPrompt,
            messages: sessionMessages,
            tools: tools
          }),
        });
        return null;
      });

      const msg = (aiResponse as any);
      sessionMessages.push({ role: 'assistant', content: msg.content });
      const toolUse = msg.content.find((c: any) => c.type === 'tool_use');

      if (!toolUse) {
        isThinking = false;
      } else {
        // Update UX so user knows which tool is running
        await step.do(`status-update-${iteration}`, async () => {
          await this.env.DB.prepare("UPDATE conversations SET content = ? WHERE summary = 1 AND role = 'system'")
            .bind(`Agent is using tool: ${toolUse.name}...`).run();
        });

        const toolResult = await step.do(`exec-${toolUse.name}-${iteration}`, async () => {
          const connectors = new Connectors(this.env);
          const browser = new BrowserTool(this.env);

          switch (toolUse.name) {
            case "search_web":
              return await browser.searchWeb(toolUse.input.query);
            case "send_email":
              return await connectors.sendEmail(toolUse.input.to, toolUse.input.subject, toolUse.input.body);
            case "post_linkedin":
              return await connectors.postLinkedIn(toolUse.input.content);
            case "search_knowledge":
              const vector = await this.env.AI.run('@cf/baai/bge-base-en-v1.5', { text: [toolUse.input.query] });
              const match = await this.env.VECTORIZE.query(vector.data[0], { topK: 3, returnMetadata: true });
              return match.matches.map(m => m.metadata);
            default:
              return "Tool not implemented.";
          }
        });

        sessionMessages.push({
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: toolUse.id, content: JSON.stringify(toolResult) }]
        });
      }
    }

    // 5. FINAL PERSISTENCE & CLEANUP
    return await step.do('final-output', async () => {
      const finalMsg = sessionMessages[sessionMessages.length - 1].content;
      const text = typeof finalMsg === 'string' ? finalMsg : finalMsg.find((c: any) => c.type === 'text')?.text || "Done.";
      
      // Remove the "Thinking..." status and insert real answer
      await this.env.DB.prepare("DELETE FROM conversations WHERE summary = 1").run();
      await this.env.DB.prepare("INSERT INTO conversations (role, content, ts) VALUES ('assistant', ?, ?)")
        .bind(text, Date.now()).run();
      
      return text;
    });
  }
}
