
import { designPrompt } from "./subagents/design-prompt";

export const DESIGN_PROMPT_TOOL = {
  name: "design_prompt",
  description:
    "Design a polished, ready-to-use image or video prompt from the user's idea and any reference images attached to this conversation turn. Call once you understand what the user wants well enough to produce something concrete.",
  parameters: {
    type: "object",
    properties: {
      idea: {
        type: "string",
        description:
          "The user's idea, restated concretely: what should be depicted, and whether it's for an image or a video.",
      },
      references: {
        type: "string",
        description:
          "Optional: how attached reference images should be used, e.g. 'match this character's face' or 'match this location's look'.",
      },
    },
    required: ["idea"],
  },
};

/** No network call — validates and echoes the prompt back. The real
 *  submission happens client-side via the existing s.generate() pipeline
 *  (queue, cost, polling, MediaCard) once it sees this tool in the reply;
 *  see StudioChat.tsx. Keeping this dumb server-side is what lets billed
 *  generation stay on its one existing code path instead of a second one. */
const GENERATE_IMAGE_TOOL = {
  name: "generate_image",
  description:
    "Submit the current prompt for real image generation. Only call this once the user has clearly asked to generate (e.g. 'generate that', 'make it') and you and they are aligned on the prompt — confirm briefly first if their ask was vague.",
  parameters: {
    type: "object",
    properties: {
      prompt: { type: "string", description: "The final prompt to generate, self-contained." },
    },
    required: ["prompt"],
  },
};

const GENERATE_VIDEO_TOOL = {
  ...GENERATE_IMAGE_TOOL,
  name: "generate_video",
  description: GENERATE_IMAGE_TOOL.description.replace("image generation", "video generation"),
};

export function toolsForKind(kind) {
  return [DESIGN_PROMPT_TOOL, kind === "video" ? GENERATE_VIDEO_TOOL : GENERATE_IMAGE_TOOL];
}

export async function dispatchTool(
  name,
  args,
  images
) {
  switch (name) {
    case "design_prompt": {
      const idea = typeof args.idea === "string" ? args.idea : "";
      const references = typeof args.references === "string" ? args.references : undefined;
      const result = await designPrompt({ idea, references, images });
      return {
        response: { prompt: result.prompt },
        trace: { tool: name, args, result },
      };
    }
    case "generate_image":
    case "generate_video": {
      const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
      if (!prompt) throw new Error(`${name} called with an empty prompt.`);
      const result = { prompt };
      return {
        response: { ok: true, prompt },
        trace: { tool: name, args, result },
      };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
