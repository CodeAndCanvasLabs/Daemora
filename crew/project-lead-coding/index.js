// Tech Lead crew member — no tools registered here.
// Lead tools (createWorker, assignTask, reviewPlan, etc.) are injected
// by TeamLeadRunner via aiToolOverrides at spawn time.
export default {
  id: "project-lead-coding",
  name: "Tech Lead",
  register(api) {
    api.log.info("Tech Lead crew ready (tools injected by TeamLeadRunner)");
  },
};
