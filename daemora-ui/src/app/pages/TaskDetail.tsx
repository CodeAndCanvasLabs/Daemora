import { useParams, Link } from "react-router";
import { ArrowLeft, Clock, DollarSign, Settings } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs";

export function TaskDetail() {
  const { id } = useParams();

  // Mock task data
  const task = {
    id,
    name: "Generate Weekly Report",
    status: "completed",
    priority: 8,
    createdAt: new Date(Date.now() - 600000),
    completedAt: new Date(Date.now() - 300000),
    input: "Generate a comprehensive weekly report summarizing all activities, metrics, and key insights.",
    output: "# Weekly Report\n\n## Summary\nThis week showed significant progress across all departments...",
    toolCalls: [
      { name: "database_query", duration: 1.2, params: { query: "SELECT * FROM activities" } },
      { name: "data_analysis", duration: 3.5, params: { dataset: "weekly_metrics" } },
      { name: "report_generator", duration: 2.1, params: { format: "markdown" } },
    ],
    cost: {
      tokens: { input: 1240, output: 3560 },
      usd: 0.45,
    },
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-4">
        <Link to="/tasks">
          <Button variant="outline" size="icon" className="bg-slate-900 border-slate-800 text-white hover:bg-slate-800">
            <ArrowLeft className="w-5 h-5" />
          </Button>
        </Link>
        <div className="flex-1">
          <h2 className="text-3xl font-bold text-white mb-2">{task.name}</h2>
          <p className="text-gray-400">Task ID: {task.id}</p>
        </div>
        <Badge className="bg-[#00ff88]/20 text-[#00ff88] border-[#00ff88]/30">
          {task.status}
        </Badge>
      </div>

      {/* Overview */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <Card className="bg-slate-900/50 border-slate-800 backdrop-blur-sm">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium text-gray-400">Priority</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-white">{task.priority}/10</div>
          </CardContent>
        </Card>

        <Card className="bg-slate-900/50 border-slate-800 backdrop-blur-sm">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium text-gray-400">Duration</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2">
              <Clock className="w-5 h-5 text-[#00d9ff]" />
              <div className="text-2xl font-bold text-white">5m 0s</div>
            </div>
          </CardContent>
        </Card>

        <Card className="bg-slate-900/50 border-slate-800 backdrop-blur-sm">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium text-gray-400">Cost</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2">
              <DollarSign className="w-5 h-5 text-[#00ff88]" />
              <div className="text-2xl font-bold text-white">${task.cost.usd.toFixed(2)}</div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Details */}
      <Card className="bg-slate-900/50 border-slate-800 backdrop-blur-sm">
        <CardContent className="p-0">
          <Tabs defaultValue="io" className="w-full">
            <TabsList className="w-full grid grid-cols-3 bg-slate-800/50 border-b border-slate-700 rounded-none">
              <TabsTrigger value="io" className="data-[state=active]:bg-slate-900 data-[state=active]:text-[#00d9ff]">
                Input / Output
              </TabsTrigger>
              <TabsTrigger value="tools" className="data-[state=active]:bg-slate-900 data-[state=active]:text-[#00d9ff]">
                Tool Calls
              </TabsTrigger>
              <TabsTrigger value="costs" className="data-[state=active]:bg-slate-900 data-[state=active]:text-[#00d9ff]">
                Cost Breakdown
              </TabsTrigger>
            </TabsList>

            <TabsContent value="io" className="p-6 space-y-6">
              <div>
                <h3 className="text-lg font-semibold text-white mb-3">Input</h3>
                <div className="bg-slate-800/50 border border-slate-700 rounded-lg p-4">
                  <pre className="text-gray-300 text-sm font-mono whitespace-pre-wrap">
                    {task.input}
                  </pre>
                </div>
              </div>
              <div>
                <h3 className="text-lg font-semibold text-white mb-3">Output</h3>
                <div className="bg-slate-800/50 border border-slate-700 rounded-lg p-4">
                  <pre className="text-gray-300 text-sm font-mono whitespace-pre-wrap">
                    {task.output}
                  </pre>
                </div>
              </div>
            </TabsContent>

            <TabsContent value="tools" className="p-6">
              <div className="space-y-4">
                {task.toolCalls.map((tool, index) => (
                  <div
                    key={index}
                    className="bg-slate-800/50 border border-slate-700 rounded-lg p-4"
                  >
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center gap-3">
                        <Settings className="w-5 h-5 text-[#00d9ff]" />
                        <span className="font-semibold text-white font-mono">{tool.name}</span>
                      </div>
                      <Badge className="bg-slate-700 text-gray-300 border-slate-600">
                        {tool.duration}s
                      </Badge>
                    </div>
                    <div className="text-sm text-gray-400">
                      <div className="font-semibold mb-1">Parameters:</div>
                      <pre className="font-mono bg-slate-900/50 p-2 rounded border border-slate-700">
                        {JSON.stringify(tool.params, null, 2)}
                      </pre>
                    </div>
                  </div>
                ))}
              </div>
            </TabsContent>

            <TabsContent value="costs" className="p-6">
              <div className="space-y-6">
                <div className="grid grid-cols-2 gap-6">
                  <Card className="bg-slate-800/50 border-slate-700">
                    <CardHeader className="pb-3">
                      <CardTitle className="text-sm font-medium text-gray-400">
                        Input Tokens
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      <div className="text-2xl font-bold text-white font-mono">
                        {task.cost.tokens.input.toLocaleString()}
                      </div>
                    </CardContent>
                  </Card>
                  <Card className="bg-slate-800/50 border-slate-700">
                    <CardHeader className="pb-3">
                      <CardTitle className="text-sm font-medium text-gray-400">
                        Output Tokens
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      <div className="text-2xl font-bold text-white font-mono">
                        {task.cost.tokens.output.toLocaleString()}
                      </div>
                    </CardContent>
                  </Card>
                </div>
                <Card className="bg-slate-800/50 border-slate-700">
                  <CardHeader className="pb-3">
                    <CardTitle className="text-sm font-medium text-gray-400">
                      Total Cost (USD)
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="text-3xl font-bold text-[#00ff88]">
                      ${task.cost.usd.toFixed(4)}
                    </div>
                  </CardContent>
                </Card>
              </div>
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
    </div>
  );
}
