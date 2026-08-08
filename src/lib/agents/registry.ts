import type { Agent, AgentRole } from "./types";
import { imageAgent } from "./imageAgent";
import { videoAgent } from "./videoAgent";
import { storyAgent } from "./storyAgent";

const AGENTS: Record<AgentRole, Agent> = {
  image: imageAgent,
  video: videoAgent,
  story: storyAgent,
};

export function getAgent(role: AgentRole): Agent {
  return AGENTS[role];
}
