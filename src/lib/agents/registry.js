
import { imageAgent } from "./imageAgent";
import { videoAgent } from "./videoAgent";
import { storyAgent } from "./storyAgent";

const AGENTS = {
  image: imageAgent,
  video: videoAgent,
  story: storyAgent,
};

export function getAgent(role) {
  return AGENTS[role];
}
