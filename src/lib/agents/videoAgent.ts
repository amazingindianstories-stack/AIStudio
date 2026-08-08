import { createChatAgent } from "./base";

// TODO: once agents can call media tools, this is where video generation
// (providers/seedance.ts, providers/omni.ts) gets wired in as a callable tool.
export const videoAgent = createChatAgent("video");
