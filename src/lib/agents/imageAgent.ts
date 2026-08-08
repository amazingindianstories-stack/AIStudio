import { createChatAgent } from "./base";

// TODO: once agents can call media tools, this is where image generation
// (providers/gemini.ts, providers/kling.ts) gets wired in as a callable tool.
export const imageAgent = createChatAgent("image");
