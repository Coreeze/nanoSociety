/**
 * llm.ts — LLM provider abstraction for nanoSociety.
 * Uses the OpenAI SDK pointed at Groq's API. No streaming — all
 * responses are plain text parsed by the engine.
 */

import OpenAI from 'openai';
import type { LLMProvider } from './types.js';

class Semaphore {
  private queue: (() => void)[] = [];
  private active = 0;

  constructor(private max: number) {}

  async acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active++;
      return;
    }
    return new Promise<void>(resolve => this.queue.push(resolve));
  }

  release(): void {
    this.active--;
    const next = this.queue.shift();
    if (next) {
      this.active++;
      next();
    }
  }
}

export class GroqProvider implements LLMProvider {
  private client: OpenAI;
  private model: string;
  private semaphore: Semaphore;

  constructor(apiKey: string, model: string, concurrency: number) {
    this.client = new OpenAI({
      apiKey,
      baseURL: 'https://api.groq.com/openai/v1',
    });
    this.model = model;
    this.semaphore = new Semaphore(concurrency);
  }

  async generate(system: string, user: string, maxTokens = 128): Promise<string> {
    await this.semaphore.acquire();
    try {
      const response = await this.client.chat.completions.create({
        model: this.model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        temperature: 1,
        max_tokens: maxTokens,
        top_p: 1,
        stream: false,
      });
      return response.choices[0]?.message?.content?.trim() ?? '';
    } finally {
      this.semaphore.release();
    }
  }
}

export function createLLMProvider(): LLMProvider {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error('GROQ_API_KEY not set in environment');
  const model = process.env.LLM_MODEL ?? 'openai/gpt-oss-120b';
  const concurrency = parseInt(process.env.LLM_CONCURRENCY ?? '25', 10);
  return new GroqProvider(apiKey, model, concurrency);
}
