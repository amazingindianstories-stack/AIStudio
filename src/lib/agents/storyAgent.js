import { createChatAgent } from "./base";

// TODO: once agents can call media tools, this is where the story agent
// orchestrates imageAgent/videoAgent as tools (see the AIStudio guide's
// original vision — not implemented in v1).
export const storyAgent = createChatAgent("story");
