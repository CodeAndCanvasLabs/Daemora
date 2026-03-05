import { useEffect, useState } from "react";
import { Link } from "react-router";
import { Search, Filter, Clock, CheckCircle2, AlertCircle, Loader2 } from "lucide-react";
import { Card, CardContent, CardHeader } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";

interface Task {
  id: string;
  status: string;
  channel: string;
  input: string;
  cost: number;
  createdAt: string;
  completedAt: string | null;
}

export function Tasks() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [search, setSearch] = useState("");

  const fetchTasks = async () => {
    try {
      const res = await fetch("/api/tasks?limit=50");
      if (res.ok) {
        const data = await res.json();
        setTasks(data.tasks || []);
      }
    } catch (error) {
      console.error("Failed to fetch tasks", error);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchTasks();
    const interval = setInterval(fetchTasks, 15000);
    return () => clearInterval(interval);
  }, []);

  const filteredTasks = tasks.filter((task) =>
    task.input.toLowerCase().includes(search.toLowerCase()) ||
    task.id.toLowerCase().includes(search.toLowerCase())
  );

  if (isLoading && tasks.length === 0) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="w-8 h-8 text-[#00d9ff] animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-3xl font-bold text-white mb-2 uppercase tracking-tighter">Task Protocol</h2>
          <p className="text-gray-400 font-mono text-sm tracking-widest">SYSTEM EXECUTION LOGS // ARCHIVE</p>
        </div>
      </div>

      {/* Filters */}
      <div className="flex gap-4">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
          <Input
            placeholder="SEARCH BY INPUT OR TASK ID..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-10 bg-slate-900/50 border-slate-800 text-white font-mono text-xs tracking-wider"
          />
        </div>
        <Button variant="outline" className="border-slate-800 text-gray-400 hover:text-white font-mono text-xs uppercase">
          <Filter className="w-4 h-4 mr-2" />
          Filter
        </Button>
      </div>

      {/* Task List */}
      <Card className="bg-slate-900/50 border-slate-800 backdrop-blur-sm shadow-xl overflow-hidden">
        <CardHeader className="border-b border-slate-800/50 bg-slate-800/20 py-4">
          <div className="grid grid-cols-12 gap-4 text-[10px] font-mono text-gray-500 uppercase tracking-widest px-6">
            <div className="col-span-1">Status</div>
            <div className="col-span-2">Task ID</div>
            <div className="col-span-5">Input</div>
            <div className="col-span-2">Channel</div>
            <div className="col-span-2 text-right">Created At</div>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <div className="divide-y divide-slate-800/50">
            {filteredTasks.length === 0 ? (
              <div className="text-center py-20">
                <p className="text-gray-600 font-mono uppercase tracking-widest text-xs">NO RECORDS MATCHING QUERY</p>
              </div>
            ) : (
              filteredTasks.map((task) => (
                <Link
                  key={task.id}
                  to={`/tasks/${task.id}`}
                  className="grid grid-cols-12 gap-4 p-4 px-6 items-center hover:bg-[#00d9ff]/5 transition-colors group"
                >
                  <div className="col-span-1">
                    {task.status === "running" ? (
                      <Clock className="w-4 h-4 text-[#ffaa00] animate-pulse" />
                    ) : task.status === "completed" ? (
                      <CheckCircle2 className="w-4 h-4 text-[#00ff88]" />
                    ) : (
                      <AlertCircle className="w-4 h-4 text-[#ff4458]" />
                    )}
                  </div>
                  <div className="col-span-2 font-mono text-[10px] text-gray-400 truncate uppercase">
                    {task.id.split("-")[0]}...
                  </div>
                  <div className="col-span-5 text-sm text-gray-200 truncate group-hover:text-[#00d9ff] transition-colors font-mono">
                    {task.input}
                  </div>
                  <div className="col-span-2">
                    <Badge variant="outline" className="bg-slate-800/50 border-slate-700 text-[10px] font-mono text-gray-400 uppercase">
                      {task.channel}
                    </Badge>
                  </div>
                  <div className="col-span-2 text-right font-mono text-[10px] text-gray-500 uppercase">
                    {new Date(task.createdAt).toLocaleDateString()} {new Date(task.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </div>
                </Link>
              ))
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
