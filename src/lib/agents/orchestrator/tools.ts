import type { GeminiPart, GeminiToolDeclaration } from "../llm-provider";
import { designPrompt } from "./subagents/design-prompt";

export const DESIGN_PROMPT_TOOL: GeminiToolDeclaration = {
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

export const TOOLS: GeminiToolDeclaration[] = [DESIGN_PROMPT_TOOL];

export interface ToolDispatchResult {
  response: Record<string, unknown>;
  trace: { tool: string; args: unknown; result: unknown };
}

export async function dispatchTool(
  name: string,
  args: Record<string, unknown>,
  images: GeminiPart[]
): Promise<ToolDispatchResult> {
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
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
