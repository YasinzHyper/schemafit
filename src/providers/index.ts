import type { Provider, ProviderId, Rule } from "../types.js";
import { anthropic } from "./anthropic.js";
import { gemini } from "./gemini.js";
import { openai } from "./openai.js";

export const providers: Readonly<Record<ProviderId, Provider>> = { openai, anthropic, gemini };

export const rules: readonly Rule[] = Object.values(providers).flatMap((provider) => provider.rules);
