// ─── Tool imports ─────────────────────────────────────────────────────────────
import { executeCommand } from "./executeCommand.js";
import { readFile } from "./readFile.js";
import { writeFile } from "./writeFile.js";
import { editFile } from "./editFile.js";
import { listDirectory } from "./listDirectory.js";
// searchFiles + searchContent removed — duplicates of glob + grep
import { webFetch } from "./webFetch.js";
import { webSearch } from "./webSearch.js";
import { sendEmail } from "./sendEmail.js";
import { createDocument } from "./createDocument.js";
import { browserAction } from "./browserAutomation.js";
import {
  readMemory, writeMemory,
  readDailyLog, writeDailyLog,
  searchMemory, pruneMemory, listMemoryCategories,
} from "./memory.js";
import { spawnSubAgent, spawnParallelAgents } from "../agents/SubAgentManager.js";
import { delegateToAgent } from "../a2a/A2AClient.js";
import { transcribeAudio } from "./transcribeAudio.js";
import { sendFile } from "./sendFile.js";
// replyWithFile removed — duplicate of sendFile
import { textToSpeech } from "./textToSpeech.js";
import { globSearch } from "./glob.js";
import { grep } from "./grep.js";
import { applyPatch } from "./applyPatch.js";
import { imageAnalysis } from "./imageAnalysis.js";
import { screenCapture } from "./screenCapture.js";
import { manageAgents } from "./manageAgents.js";
import { cron } from "./cronTool.js";
import { messageChannel } from "./messageChannel.js";
import { projectTracker } from "./projectTracker.js";
import { taskManager } from "./taskManager.js";
import { manageMCP } from "./manageMCP.js";
import { useMCP } from "./useMCP.js";
import { makeVoiceCall } from "./makeVoiceCall.js";
import { teamTask } from "./teamTool.js";
import { meetingAction } from "./meetingTool.js";
import { replyToUser } from "./replyToUser.js";
import { generateImage } from "./generateImage.js";
import { readPDF } from "./readPDF.js";
import { gitTool } from "./gitTool.js";
import { clipboard } from "./clipboard.js";
// Moved to bundled plugins: calendar, contacts, googlePlaces, philipsHue, sonos,
// notification, iMessageTool, sshTool, database
// They register via plugins/ on startup — no longer hardcoded here.
import { reload } from "./reloadTool.js";
import { discoverProfiles } from "./discoverProfiles.js";
import { broadcast } from "./broadcast.js";
import { goal } from "./goalTool.js";
import { watcher } from "./watcherTool.js";

// ─── Agent wrappers (params object → SubAgentManager) ────────────────────────

function spawnAgent(params) {
  const taskDescription = params?.taskDescription;
  // Merge flat fields with legacy options JSON
  const optionsStr = params?.options;
  const legacyOpts = optionsStr ? (typeof optionsStr === "string" ? JSON.parse(optionsStr) : optionsStr) : {};
  const { taskDescription: _, options: _o, ...flatFields } = params || {};
  const options = { ...legacyOpts, ...flatFields };
  return spawnSubAgent(taskDescription, options);
}

function parallelAgents(params) {
  // New schema: tasks is array of objects, sharedContext is flat string
  // Legacy: tasks is JSON string, sharedOptions is JSON string
  const tasksRaw = params?.tasks;
  const rawTasks = typeof tasksRaw === "string" ? JSON.parse(tasksRaw) : (tasksRaw || []);
  // Normalize: schema puts profile/parentContext at top level, spawnParallelAgents expects them inside options
  const tasks = rawTasks.map(t => {
    const { description, profile, parentContext, ...rest } = t;
    return { description, options: { profile, parentContext, ...t.options, ...rest } };
  });
  const sharedStr = params?.sharedOptions;
  const legacyShared = sharedStr ? (typeof sharedStr === "string" ? JSON.parse(sharedStr) : sharedStr) : {};
  const sharedOptions = params?.sharedContext ? { ...legacyShared, sharedContext: params.sharedContext } : legacyShared;
  return spawnParallelAgents(tasks, sharedOptions);
}

// ─── Tool Functions Map ──────────────────────────────────────────────────────

export const toolFunctions = {
  readFile, writeFile, editFile, listDirectory,
  glob: globSearch, grep, applyPatch,
  executeCommand,
  webFetch, webSearch,
  browserAction,
  sendEmail, messageChannel, sendFile, replyToUser,
  transcribeAudio, textToSpeech,
  createDocument,
  readMemory, writeMemory, readDailyLog, writeDailyLog,
  searchMemory, pruneMemory, listMemoryCategories,
  spawnAgent, parallelAgents, delegateToAgent, manageAgents,
  projectTracker, taskManager,
  cron,
  imageAnalysis, screenCapture,
  manageMCP, useMCP,
  makeVoiceCall,
  teamTask,
  meetingAction,
  generateImage, readPDF,
  gitTool, clipboard,
  discoverProfiles,
  broadcast,
  goal,
  watcher,
  reload,
};

/**
 * Merge plugin-registered tools into the core tool map.
 * Called after plugins load in startup sequence.
 */
export async function mergePluginTools() {
  try {
    const { getPluginTools } = await import("../plugins/PluginRegistry.js");
    const { registerPluginSchema } = await import("./schemas.js");
    const pluginTools = getPluginTools();
    for (const { name, fn, schema, description } of pluginTools) {
      if (toolFunctions[name]) {
        console.log(`[Tools] Plugin tool "${name}" skipped — name conflicts with built-in`);
        continue;
      }
      toolFunctions[name] = fn;
      registerPluginSchema(name, schema, description);
    }
    if (pluginTools.length > 0) {
      console.log(`[Tools] Merged ${pluginTools.length} plugin tool(s) + schemas`);
    }
  } catch {}
}
