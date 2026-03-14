/**
 * llm.ts — LLM provider abstraction for nanoSociety.
 * Uses the OpenAI SDK pointed at OpenRouter's API. No JSON mode — all
 * responses are plain text parsed by the engine. Model is configurable
 * via LLM_MODEL env var and supports any OpenRouter-available model.
 */

import OpenAI from 'openai';
import type { LLMProvider } from './types.js';

export class OpenRouterProvider implements LLMProvider {
  private client: OpenAI;
  private model: string;

  constructor(apiKey: string, model: string) {
    this.client = new OpenAI({
      apiKey,
      baseURL: 'https://openrouter.ai/api/v1',
    });
    this.model = model;
  }

  async generate(system: string, user: string, maxTokens = 512): Promise<string> {
    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: 0.9,
      max_tokens: maxTokens,
    });
    return response.choices[0]?.message?.content?.trim() ?? '';
  }
}

export function createLLMProvider(): LLMProvider {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('OPENROUTER_API_KEY not set in environment');
  const model = process.env.LLM_MODEL ?? 'groq/llama-3.3-70b-versatile';
  return new OpenRouterProvider(apiKey, model);
}
