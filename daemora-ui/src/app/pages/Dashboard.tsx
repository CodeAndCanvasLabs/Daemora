import { useEffect, useState } from "react";
import { apiFetch } from "../api";
import { Link } from "react-router";
import { Activity, AlertCircle, CheckCircle2, Clock, Zap } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "../components/ui/card";
import { PageHeader, MetricCard, StatusBadge, LoadingSpinner, EmptyState } from "../components/shared";
import { toast } from "sonner";

interface SystemHealth {
  status: string;
  uptime: number;
  tools: number;
  model: string;
  permissionTier: string;
  queue: { pending: number; running: number; completed: number; failed: number; total: number };
  todayCost: number;
}

interface TaskSummary {
  id: string;
  status: string;
  type: string;
  title: string | null;
  channel: string;
  input: string;
  cost: number;
  agentId: string | null;
  agentCreated: boolean;
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
        apiFetch("/api/health"),
        apiFetch("/api/tasks?limit=5&type=task"),
      ]);
      if (healthRes.ok) setHealth(await healthRes.json());
      if (tasksRes.ok) {
        const data = await tasksRes.json();
        setTasks(data.tasks || []);
      }
    } catch (error) {
      toast.error("Failed to fetch dashboard data");
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
    return <LoadingSpinner text="Loading dashboard..." />;
  }

  return (
    <div className="space-y-8">
      <PageHeader title="Dashboard" subtitle="System Overview" />

      {/* Stats Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <MetricCard
          icon={health?.status === "ok" ? <CheckCircle2 className="w-7 h-7" /> : <AlertCircle className="w-7 h-7" />}
          label="System Status"
          value={health?.status === "ok" ? "Healthy" : "Offline"}
          sub={`Uptime: ${health ? formatUptime(health.uptime) : "0h 0m"}`}
          color={health?.status === "ok" ? "success" : "destructive"}
        />
        <MetricCard
          icon={<Activity className="w-7 h-7" />}
          label="Active Tasks"
          value={health?.queue?.running || 0}
          sub={`of ${health?.queue?.total || 0} total`}
          color="primary"
        />
        <MetricCard
          icon={<Zap className="w-7 h-7" />}
          label="Tools Loaded"
          value={health?.tools || 0}
          sub="available"
          color="info"
        />
        <MetricCard
          icon={<CheckCircle2 className="w-7 h-7" />}
          label="Daily Spend"
          value={`$${health?.todayCost?.toFixed(2) || "0.00"}`}
          sub="USD today"
          color="primary"
        />
      </div>

      {/* Recent Tasks */}
      <Card className="bg-card/50 border-border">
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-foreground">Recent Activity</CardTitle>
              <CardDescription className="text-muted-foreground text-xs">Latest tasks</CardDescription>
            </div>
            <Link to="/tasks" className="text-sm text-primary hover:text-secondary transition-colors font-medium">
              View all →
            </Link>
          </div>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {tasks.length === 0 ? (
              <EmptyState
                icon={<Activity className="w-10 h-10" />}
                title="No tasks yet"
                description="Tasks will appear here as they're processed."
              />
            ) : (
              tasks.map((task) => (
                <div
                  key={task.id}
                  className="flex items-center justify-between p-3 bg-muted/30 rounded-lg border border-border hover:border-primary/30 transition-all group"
                >
                  <div className="flex items-center gap-3">
                    {task.status === "running" ? (
                      <Clock className="w-4 h-4 text-warning animate-pulse" />
                    ) : task.status === "completed" ? (
                      <CheckCircle2 className="w-4 h-4 text-success" />
                    ) : (
                      <AlertCircle className="w-4 h-4 text-destructive" />
                    )}
                    <div>
                      <div className="text-sm font-medium text-foreground truncate max-w-[300px] group-hover:text-primary transition-colors">
                        {task.title || task.input}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {task.agentCreated ? "agent" : task.channel} · {new Date(task.createdAt).toLocaleString()}
                      </div>
                    </div>
                  </div>
                  <StatusBadge status={task.status} />
                </div>
              ))
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
