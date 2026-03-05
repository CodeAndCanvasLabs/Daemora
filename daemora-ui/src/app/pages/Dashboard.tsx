import { useEffect, useState } from "react";
import { Link } from "react-router";
import { Activity, AlertCircle, CheckCircle2, Clock, Zap, Loader2 } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Badge } from "../components/ui/badge";

interface SystemHealth {
  status: string;
  uptime: number;
  tools: number;
  model: string;
  permissionTier: string;
  queue: {
    pending: number;
    running: number;
    completed: number;
    failed: number;
    total: number;
  };
  todayCost: number;
}

interface TaskSummary {
  id: string;
  status: string;
  channel: string;
  input: string;
  cost: number;
  createdAt: string;
  completedAt: string | null;
}

export function Dashboard() {
  const [health, setHealth] = useState<SystemHealth | null>(null);
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const fetchData = async () => {
    try {
      const [healthRes, tasksRes] = await Promise.all([
        fetch("/api/health"),
        fetch("/api/tasks?limit=5")
      ]);
      
      if (healthRes.ok) setHealth(await healthRes.json());
      if (tasksRes.ok) {
        const data = await tasksRes.json();
        setTasks(data.tasks || []);
      }
    } catch (error) {
      console.error("Failed to fetch dashboard data", error);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 10000);
    return () => clearInterval(interval);
  }, []);

  const formatUptime = (seconds: number) => {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return `${hours}h ${minutes}m`;
  };

  if (isLoading && !health) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="w-8 h-8 text-[#00d9ff] animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {/* Header */}
      <div>
        <h2 className="text-3xl font-bold text-white mb-2 uppercase tracking-tighter">Dashboard</h2>
        <p className="text-gray-400 font-mono text-sm tracking-widest">SYSTEM OVERVIEW</p>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        <Card className="bg-slate-900/50 border-slate-800 backdrop-blur-sm shadow-xl">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium text-gray-400 uppercase">System Status</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2">
              {health?.status === "ok" ? (
                <CheckCircle2 className="w-8 h-8 text-[#00ff88]" />
              ) : (
                <AlertCircle className="w-8 h-8 text-[#ff4458]" />
              )}
              <div>
                <div className="text-2xl font-bold text-white uppercase tracking-tight">
                  {health?.status === "ok" ? "Healthy" : "Offline"}
                </div>
                <div className="text-xs text-gray-400 font-mono uppercase">UPTIME: {health ? formatUptime(health.uptime) : "0h 0m"}</div>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="bg-slate-900/50 border-slate-800 backdrop-blur-sm shadow-xl">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium text-gray-400 uppercase">Active Tasks</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2">
              <Activity className="w-8 h-8 text-[#00d9ff]" />
              <div>
                <div className="text-2xl font-bold text-white">{health?.queue?.running || 0}</div>
                <div className="text-xs text-gray-400 font-mono uppercase">OF {health?.queue?.total || 0} TOTAL</div>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="bg-slate-900/50 border-slate-800 backdrop-blur-sm shadow-xl">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium text-gray-400 uppercase">Tools Loaded</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2">
              <Zap className="w-8 h-8 text-[#7C6AFF]" />
              <div>
                <div className="text-2xl font-bold text-white">{health?.tools || 0}</div>
                <div className="text-xs text-gray-400 font-mono uppercase">AVAILABLE</div>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="bg-slate-900/50 border-slate-800 backdrop-blur-sm shadow-xl">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium text-gray-400 uppercase">Daily Spend</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2">
              <CheckCircle2 className="w-8 h-8 text-[#4ECDC4]" />
              <div>
                <div className="text-2xl font-bold text-white">${health?.todayCost?.toFixed(2) || "0.00"}</div>
                <div className="text-xs text-gray-400 font-mono uppercase">USD TODAY</div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Recent Tasks */}
      <Card className="bg-slate-900/50 border-slate-800 backdrop-blur-sm shadow-xl">
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-white uppercase tracking-tighter">Recent Activity</CardTitle>
              <CardDescription className="text-gray-400 font-mono text-xs">LATEST TASKS</CardDescription>
            </div>
            <Link
              to="/tasks"
              className="text-sm text-[#00d9ff] hover:text-[#4ECDC4] transition-colors font-medium font-mono"
            >
              VIEW ALL →
            </Link>
          </div>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            {tasks.length === 0 ? (
              <div className="text-center py-12 border-2 border-dashed border-slate-800 rounded-xl">
                <p className="text-gray-500 font-mono uppercase tracking-widest text-xs">NO TASKS YET</p>
              </div>
            ) : (
              tasks.map((task) => (
                <div
                  key={task.id}
                  className="flex items-center justify-between p-4 bg-slate-800/30 rounded-lg border border-slate-800 hover:border-[#00d9ff]/30 transition-all group"
                >
                  <div className="flex items-center gap-4">
                    {task.status === "running" ? (
                      <Clock className="w-5 h-5 text-[#ffaa00] animate-pulse" />
                    ) : task.status === "completed" ? (
                      <CheckCircle2 className="w-5 h-5 text-[#00ff88]" />
                    ) : (
                      <AlertCircle className="w-5 h-5 text-[#ff4458]" />
                    )}
                    <div>
                      <div className="font-medium text-white truncate max-w-[300px] group-hover:text-[#00d9ff] transition-colors font-mono">{task.input}</div>
                      <div className="text-xs text-gray-500 font-mono uppercase tracking-tighter">
                        {task.channel} // {new Date(task.createdAt).toLocaleString()}
                      </div>
                    </div>
                  </div>
                  <Badge
                    className={
                      task.status === "running"
                        ? "bg-[#ffaa00]/10 text-[#ffaa00] border-[#ffaa00]/30 font-mono text-[10px]"
                        : task.status === "completed"
                        ? "bg-[#00ff88]/10 text-[#00ff88] border-[#00ff88]/30 font-mono text-[10px]"
                        : "bg-[#ff4458]/10 text-[#ff4458] border-[#ff4458]/30 font-mono text-[10px]"
                    }
                  >
                    {task.status.toUpperCase()}
                  </Badge>
                </div>
              ))
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
