import { z } from "zod";
import { twitterTool } from "./tools/twitter.js";

export default {
  id: "twitter",
  name: "X (Twitter)",

  register(api) {
    api.registerTool(
      "twitterAction",
      twitterTool,
      z.object({
        action: z.string().describe("Action: post | reply | like | retweet | search | timeline | get_user | delete"),
        text: z.string().optional().describe("Tweet text (for post/reply)"),
        tweetId: z.string().optional().describe("Tweet ID (for reply/like/retweet/delete)"),
        query: z.string().optional().describe("Search query (for search)"),
        username: z.string().optional().describe("Username (for get_user/timeline)"),
        maxResults: z.number().optional().describe("Max results (default: 10)"),
      }),
      "Post, reply, search, like, retweet on X/Twitter"
    );
    api.log.info("Registered: twitterAction");
  },
};
