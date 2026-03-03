import { z } from "zod";

const outputSchema = z.object({
  type: z.enum(["text", "tool_call"]),
  text_content: z.string().nullable(),
  tool_call: z
    .object({
      tool_name: z.string(),
      params: z.array(z.string()),
    })
    .nullable(),
  finalResponse: z.boolean(),
});

export default outputSchema;
