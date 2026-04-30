import { useEffect, useState } from "react";
import { apiFetch } from "../api";
import { Sparkles, RefreshCw, Loader2 } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { toast } from "sonner";

interface Skill {
  name: string;
  description: string;
}

export function Skills() {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const fetchData = async () => {
    try {
      const res = await apiFetch("/api/skills");
      if (res.ok) {
        const data = await res.json();
        setSkills(data.skills || []);
      }
    } catch (error) {
      console.error("Failed to fetch skills", error);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  const handleReloadSkills = async () => {
    const toastId = toast.loading("Reloading skills...");
    try {
      // POST /api/skills/reload re-scans disk and returns { loaded, skipped }
      // counts only — re-fetch /api/skills afterwards to refresh the list.
      const reloadRes = await apiFetch("/api/skills/reload", { method: "POST" });
      if (!reloadRes.ok) {
        toast.error("Failed to reload skills", { id: toastId });
        return;
      }
      const counts = await reloadRes.json();
      const listRes = await apiFetch("/api/skills");
      if (listRes.ok) {
        const data = await listRes.json();
        setSkills(data.skills || []);
      }
      toast.success(`Skills reloaded (${counts.loaded ?? 0} loaded)`, { id: toastId });
    } catch (err) {
      toast.error("Failed to reload skills", { id: toastId });
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="w-8 h-8 text-[#00d9ff] animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h2 className="text-3xl font-bold text-white mb-2 uppercase tracking-tighter">Skills</h2>
        <p className="text-gray-400 font-mono text-sm tracking-widest">AGENT CAPABILITIES</p>
      </div>

      <div>
        <Card className="bg-slate-900/50 border-slate-800 backdrop-blur-sm shadow-xl">
          <CardHeader className="border-b border-slate-800/50">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <Sparkles className="w-6 h-6 text-[#00d9ff]" />
                <div>
                  <CardTitle className="text-white uppercase tracking-tight">Loaded Skills</CardTitle>
                  <CardDescription className="text-gray-500 font-mono text-[10px] uppercase">
                    AVAILABLE CAPABILITIES
                  </CardDescription>
                </div>
              </div>
              <Button
                onClick={handleReloadSkills}
                variant="ghost"
                size="sm"
                className="text-gray-400 hover:text-[#00d9ff] font-mono text-[10px] uppercase tracking-wider"
              >
                <RefreshCw className="w-3 h-3 mr-2" />
                Reload
              </Button>
            </div>
          </CardHeader>
          <CardContent className="pt-6">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {skills.length === 0 ? (
                <div className="col-span-full text-center py-12 text-gray-600 font-mono uppercase text-xs">No skills detected in /skills directory</div>
              ) : (
                skills.map((skill) => (
                  <div
                    key={skill.name}
                    className="p-4 bg-slate-800/30 border border-slate-800 rounded-lg hover:border-[#00d9ff]/30 transition-colors group"
                  >
                    <div className="font-mono text-sm text-[#00d9ff] uppercase tracking-tighter mb-1 group-hover:text-white transition-colors">{skill.name}</div>
                    <p className="text-xs text-gray-500 font-mono leading-relaxed lowercase">{skill.description}</p>
                  </div>
                ))
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
