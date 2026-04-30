import { useEffect, useState } from "react";
import { apiFetch } from "../api";
import { DollarSign, TrendingUp, AlertCircle, Loader2 } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Progress } from "../components/ui/progress";
import { Badge } from "../components/ui/badge";

interface CostData {
  date: string;
  totalCost: number;
  dailyLimit: number;
  remaining: number;
}

export function Costs() {
  const [cost, setCost] = useState<CostData | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const fetchData = async () => {
    try {
      const costRes = await apiFetch("/api/costs/today");
      if (costRes.ok) setCost(await costRes.json());
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
        <h2 className="text-3xl font-bold text-white mb-2 uppercase tracking-tighter">Costs</h2>
        <p className="text-gray-400 font-mono text-sm tracking-widest">USAGE & SPENDING</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Daily Limit */}
        <Card className="lg:col-span-2 bg-slate-900/50 border-slate-800 backdrop-blur-sm shadow-xl">
          <CardHeader>
            <div className="flex items-center gap-3">
              <DollarSign className="w-6 h-6 text-[#00d9ff]" />
              <div>
                <CardTitle className="text-white uppercase tracking-tight">Daily Spend</CardTitle>
                <CardDescription className="text-gray-500 font-mono text-[10px] uppercase">
                  CURRENT USAGE VS. LIMIT
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
                  WARNING: APPROACHING DAILY COST LIMIT. TASKS MAY BE THROTTLED.
                </p>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Breakdown Stats */}
        <div className="space-y-6">
        </div>
      </div>
    </div>
  );
}
