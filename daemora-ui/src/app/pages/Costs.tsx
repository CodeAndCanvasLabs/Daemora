import { useEffect, useState } from "react";
import { DollarSign, TrendingUp, AlertCircle, Loader2, Users } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Progress } from "../components/ui/progress";
import { Badge } from "../components/ui/badge";

interface CostData {
  date: string;
  totalCost: number;
  dailyLimit: number;
  remaining: number;
}

interface Tenant {
  id: string;
  name?: string;
  planTier: string;
  usage: {
    totalCost: number;
    taskCount: number;
  };
}

export function Costs() {
  const [cost, setCost] = useState<CostData | null>(null);
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const fetchData = async () => {
    try {
      const [costRes, tenantsRes] = await Promise.all([
        fetch("/api/costs/today"),
        fetch("/api/tenants")
      ]);
      if (costRes.ok) setCost(await costRes.json());
      if (tenantsRes.ok) {
        const data = await tenantsRes.json();
        setTenants(data.tenants || []);
      }
    } catch (error) {
      console.error("Failed to fetch cost data", error);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  if (isLoading || !cost) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="w-8 h-8 text-[#00d9ff] animate-spin" />
      </div>
    );
  }

  const usagePercentage = (cost.totalCost / (cost.dailyLimit || 1)) * 100;
  const isNearLimit = usagePercentage > 80;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h2 className="text-3xl font-bold text-white mb-2 uppercase tracking-tighter">Finance Node</h2>
        <p className="text-gray-400 font-mono text-sm tracking-widest">RESOURCE CONSUMPTION // QUOTA MONITOR</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Daily Limit */}
        <Card className="lg:col-span-2 bg-slate-900/50 border-slate-800 backdrop-blur-sm shadow-xl">
          <CardHeader>
            <div className="flex items-center gap-3">
              <DollarSign className="w-6 h-6 text-[#00d9ff]" />
              <div>
                <CardTitle className="text-white uppercase tracking-tight">Cycle Expenditure</CardTitle>
                <CardDescription className="text-gray-500 font-mono text-[10px] uppercase">
                  CURRENT USAGE VS. HARD LIMIT
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-8 pt-4">
            <div className="flex items-end justify-between">
              <div>
                <div className="text-5xl font-bold text-white font-mono tracking-tighter">
                  ${cost.totalCost.toFixed(3)}
                </div>
                <div className="text-[10px] text-gray-500 font-mono uppercase mt-2">
                  Of ${cost.dailyLimit.toFixed(2)} configured limit
                </div>
              </div>
              <div className="text-right">
                <Badge
                  variant="outline"
                  className={
                    isNearLimit
                      ? "bg-[#ff4458]/10 text-[#ff4458] border-[#ff4458]/30 font-mono"
                      : "bg-[#00ff88]/10 text-[#00ff88] border-[#00ff88]/30 font-mono"
                  }
                >
                  {usagePercentage.toFixed(1)}% CONSUMED
                </Badge>
                <div className="text-[10px] text-gray-600 font-mono uppercase mt-2">
                  Remaining: ${cost.remaining.toFixed(3)}
                </div>
              </div>
            </div>
            
            <div className="space-y-2">
              <Progress
                value={usagePercentage}
                className="h-2 bg-slate-800"
              />
              <div className="flex justify-between text-[8px] font-mono text-gray-600 uppercase tracking-widest">
                <span>0.00</span>
                <span>Threshold</span>
                <span>{cost.dailyLimit.toFixed(2)}</span>
              </div>
            </div>

            {isNearLimit && (
              <div className="flex items-center gap-3 p-4 bg-red-500/10 border border-red-500/20 rounded-xl">
                <AlertCircle className="w-5 h-5 text-red-500 flex-shrink-0" />
                <p className="text-[10px] text-red-400 font-mono uppercase tracking-tight">
                  CRITICAL: APPROACHING DAILY EXPENDITURE CAP. AGENT THROTTLING MAY OCCUR.
                </p>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Breakdown Stats */}
        <div className="space-y-6">
          <Card className="bg-slate-900/50 border-slate-800 backdrop-blur-sm shadow-xl">
            <CardHeader className="pb-2">
              <CardTitle className="text-xs font-mono text-gray-500 uppercase tracking-widest">Avg Efficiency</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-white font-mono uppercase">
                ${(cost.totalCost / (tenants.reduce((sum, t) => sum + (t?.usage?.taskCount || 0), 0) || 1)).toFixed(4)}
              </div>
              <div className="text-[9px] text-gray-600 font-mono uppercase mt-1">Cost Per Task (Global)</div>
            </CardContent>
          </Card>

          <Card className="bg-slate-900/50 border-slate-800 backdrop-blur-sm shadow-xl">
            <CardHeader className="pb-2">
              <CardTitle className="text-xs font-mono text-gray-500 uppercase tracking-widest">Active Tenants</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-[#7C6AFF] font-mono uppercase">
                {tenants.length}
              </div>
              <div className="text-[9px] text-gray-600 font-mono uppercase mt-1">Resource Isolation Units</div>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Tenant Usage */}
      <Card className="bg-slate-900/50 border-slate-800 backdrop-blur-sm shadow-xl">
        <CardHeader className="border-b border-slate-800/50">
          <div className="flex items-center gap-3">
            <Users className="w-6 h-6 text-[#4ECDC4]" />
            <div>
              <CardTitle className="text-white uppercase tracking-tight">Tenant Isolation Breakdown</CardTitle>
              <CardDescription className="text-gray-500 font-mono text-[10px] uppercase">
                RESOURCE ALLOCATION PER USER/CHANNEL
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="pt-6">
          <div className="space-y-4">
            {tenants.length === 0 ? (
              <div className="text-center py-12 text-gray-700 font-mono uppercase text-[10px] tracking-widest">No multi-tenant data available</div>
            ) : (
              tenants.map((tenant) => (
                <div
                  key={tenant.id}
                  className="p-4 bg-slate-800/20 border border-slate-800/50 rounded-xl hover:border-[#00d9ff]/20 transition-colors group"
                >
                  <div className="flex items-center justify-between mb-4">
                    <div>
                      <div className="flex items-center gap-2 mb-1">
                        <div className="font-mono text-sm text-white uppercase truncate max-w-[200px]">{tenant.name || tenant.id}</div>
                        <Badge variant="outline" className="text-[8px] h-4 uppercase border-slate-700 text-gray-500">{tenant.planTier}</Badge>
                      </div>
                      <div className="text-[10px] text-gray-600 font-mono uppercase tracking-tighter">{(tenant?.usage?.taskCount || 0)} PROTOCOLS EXECUTED</div>
                    </div>
                    <div className="text-right">
                      <div className="text-xl font-bold text-[#00d9ff] font-mono tracking-tighter">
                        ${(tenant?.usage?.totalCost || 0).toFixed(3)}
                      </div>
                      <div className="text-[9px] text-gray-600 font-mono uppercase">
                        {(((tenant?.usage?.totalCost || 0) / (cost.totalCost || 1)) * 100).toFixed(1)}% OF GLOBAL SPEND
                      </div>
                    </div>
                  </div>
                  <Progress
                    value={((tenant?.usage?.totalCost || 0) / (cost.totalCost || 1)) * 100}
                    className="h-1 bg-slate-900"
                  />
                </div>
              ))
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
